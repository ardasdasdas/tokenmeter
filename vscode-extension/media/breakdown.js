// Tokenmeter breakdown view. Tokens are inserted with textContent only.
(function () {
  const vscode = acquireVsCodeApi();
  const MAX_RENDER = 4000;
  const nf = new Intl.NumberFormat('en-US');
  const $ = (id) => document.getElementById(id);
  const showIds = $('show-ids');
  let data;

  function visible(piece) {
    const frag = document.createDocumentFragment();
    for (const part of piece.split(/(\n| |\t)/)) {
      if (!part) continue;
      if (part === '\n' || part === ' ' || part === '\t') {
        const s = document.createElement('span');
        s.className = 'ws';
        s.textContent = part === '\n' ? '↵\n' : part === '\t' ? '→' : '·';
        frag.append(s);
      } else {
        frag.append(document.createTextNode(part));
      }
    }
    return frag;
  }

  function render() {
    if (!data) return;
    $('model').textContent = data.model;
    $('tokens').textContent = nf.format(data.tokenCount);
    $('chars').textContent = nf.format(data.charCount);
    $('ratio').textContent = data.tokenCount ? (data.charCount / data.tokenCount).toFixed(2) : '–';
    $('what').textContent = data.what === 'selection' ? 'selection' : 'whole document';

    const frag = document.createDocumentFragment();
    const n = Math.min(data.pieces.length, MAX_RENDER);
    for (let i = 0; i < n; i++) {
      const span = document.createElement('span');
      span.className = 'tok';
      span.title = '#' + i + ' · id ' + data.ids[i];
      span.append(visible(data.pieces[i]));
      if (showIds.checked) {
        const sub = document.createElement('sub');
        sub.textContent = String(data.ids[i]);
        span.append(sub);
      }
      frag.append(span);
    }
    if (!data.tokenCount) {
      const m = document.createElement('span');
      m.className = 'muted';
      m.textContent = 'Text is empty.';
      frag.append(m);
    }
    $('list').replaceChildren(frag);
    const note = $('note');
    note.hidden = data.tokenCount <= MAX_RENDER;
    note.textContent = 'Showing the first 4,000 tokens; the count covers the full text.';
  }

  showIds.addEventListener('change', render);
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'data') {
      data = e.data.data;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
