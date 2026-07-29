'use strict';

/*
 * Lanceur de tests : node test/run.js
 *
 * Démarre lui-même les serveurs nécessaires sur un port et un stockage
 * temporaires, enchaîne les suites, puis nettoie. Aucun serveur n'a besoin
 * d'être lancé au préalable.
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3210;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  \x1b[31mÉCHEC\x1b[0m ${message}`);
  }
}

async function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`le serveur s'est arrêté :\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return child;
    } catch { /* pas encore prêt */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`le serveur n'a pas démarré :\n${logs.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000).unref();
  });
}

async function suite(name, fn, context) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  const before = failed;
  try {
    await fn(context);
  } catch (err) {
    failed++;
    failures.push(`${name} : ${err.message}`);
    console.log(`  \x1b[31mÉCHEC\x1b[0m exception — ${err.message}`);
  }
  return failed === before;
}

(async () => {
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'youseal-test-'));
  let server = null;

  try {
    await suite('QR code', require('./qr.test.js'), { assert });

    // --- serveur aux réglages par défaut
    server = await startServer({ STORAGE_DIR: storageDir });
    await suite('API (transferts non chiffrés)', require('./api.test.js'), { base: BASE, assert });
    await suite('Chiffrement de bout en bout', require('./crypto.test.js'),
      { base: BASE, storageDir, assert });
    await suite('Destruction après téléchargement', require('./burn.test.js'),
      { base: BASE, storageDir, assert });
    await stopServer(server);
    server = null;

    // --- serveur aux seuils volontairement bas
    const limitsDir = path.join(storageDir, 'limites');
    server = await startServer({
      STORAGE_DIR: limitsDir,
      RATE_CREATE_PER_HOUR: '3',
      RATE_AUTH_PER_15MIN: '2',
      MAX_STORAGE: '200000',
      MAX_STREAM_PER_IP: '4',
      ADMIN_TOKEN: 'jeton-de-test-moderation',
    });
    await suite('Limites d\'usage et modération', require('./limits.test.js'), { base: BASE, assert });
  } catch (err) {
    failed++;
    failures.push(err.message);
    console.error(`\n\x1b[31m${err.message}\x1b[0m`);
  } finally {
    await stopServer(server);
    await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (failed) {
    console.log(`\x1b[31m${failed} échec(s)\x1b[0m sur ${passed + failed} vérifications :`);
    for (const item of failures) console.log(`  · ${item}`);
  } else {
    console.log(`\x1b[32m${passed} vérifications, aucune erreur.\x1b[0m`);
  }
  process.exitCode = failed ? 1 : 0;
})();
