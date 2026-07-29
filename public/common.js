'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function remainingLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expiré';
  const days = Math.round(ms / 86400000);
  if (ms >= 86400000) return `expire dans ${days} jour${days > 1 ? 's' : ''}`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `expire dans ${hours} h`;
  return `expire dans ${Math.max(1, Math.round(ms / 60000))} min`;
}

let toastTimer = null;
function toast(message) {
  let node = $('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}
