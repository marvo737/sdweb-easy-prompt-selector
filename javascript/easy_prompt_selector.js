/* Data and prompt bookkeeping for Easy Prompt Selector. No Gradio dependency. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EPSCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const references = () => /@(?:(\d+(?:-\d+)?)\$\$)?([^@>]+?)@/g;
  const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  // Commas in emphasis groups, LoRAs and references are not item boundaries.
  function tokens(text) {
    const result = [];
    let start = 0, depth = 0, angle = 0, reference = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '@' && !angle) reference = !reference;
      if (reference) continue;
      if (c === '<') angle++;
      if (c === '>') angle = Math.max(0, angle - 1);
      if (angle) continue;
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      if ((c === ',' || c === '\n') && depth === 0) {
        if (text.slice(start, i).trim()) result.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (text.slice(start).trim()) result.push(text.slice(start).trim());
    return result;
  }

  function tokenField(value) {
    const t = normalize(value);
    if (/^(morning|day|noon|afternoon|night|midnight|sunset|evening)$/.test(t)) return '時間帯';
    if (/^(standing|walking|sitting|lying)(\b|$)/.test(t)) return '姿勢';
    if (/^(upper body|full body|cowboy shot|waist up|close-up|extreme close-up)$/.test(t)) return '画角';
    if (/^(looking at viewer|looking away|looking to the side|looking at book)$/.test(t)) return '視線';
    return '';
  }

  class Catalog {
    constructor(tags, descriptions = {}) {
      this.tags = tags;
      this.nodes = new Map();
      this.translations = new Map();
      this.descriptions = descriptions;
      this._analysis = new Map();
      Object.entries(tags).forEach(([name, value]) => {
        if (/[:@]/.test(name)) throw new Error('ファイル名に「:」「@」は使えません：' + name);
        this.build(value, [name], false);
      });
      const common = { window: '窓', indoors: '室内', outdoors: '屋外', sunlight: '日光', 'warm indoor lighting': '室内の暖色光', 'looking at book': '本を見る', 'anime illustration': 'アニメイラスト', '1girl': '女性1人', solo: '単独', 'best quality': '最高品質', masterpiece: '傑作', 'light smile': '微笑み' };
      Object.entries(common).forEach(([tag, label]) => { if (!this.translations.has(tag)) this.translations.set(tag, label); });
    }

    build(value, path, listItem) {
      const key = path.join(':');
      const node = { key, path, label: listItem ? String(value) : path[path.length - 1], value, listItem, children: [] };
      if (typeof value === 'string') {
        node.kind = 'leaf';
        if (!value.includes('@') && tokens(value).length === 1 && !/[()[\]<>]/.test(value)) {
          const normalized = normalize(value);
          if (!this.translations.has(normalized)) this.translations.set(normalized, node.label);
        }
      } else if (Array.isArray(value)) {
        if (!value.length || value.some(v => typeof v !== 'string')) throw new Error(key + '：空でない文字列の配列にしてください。');
        node.kind = 'group';
        node.children = value.map((v, i) => this.build(v, path.concat(String(i)), true));
      } else if (value && typeof value === 'object') {
        if (!Object.keys(value).length) throw new Error(key + '：空のカテゴリです。');
        node.kind = 'group';
        node.children = Object.entries(value).map(([k, v]) => {
          if (/[:@]/.test(k)) throw new Error(key + '：項目名に「:」「@」は使えません。');
          return this.build(v, path.concat(k), false);
        });
      } else throw new Error(key + '：タグの値は文字列にしてください。');
      this.nodes.set(key, node);
      return node;
    }

    get(key) {
      const node = this.nodes.get(key);
      // Array items are displayed as literal buttons; the backend cannot address
      // them with a string index in an @reference@.
      if (!node || node.listItem) throw new Error('参照先が見つかりません：' + key);
      return node;
    }

    input(node) { return node.kind === 'group' ? '@' + node.key + '@' : node.value; }

    displayName(node) {
      const generic = /^(フルセット|髪型|目元|体型・特徴|雰囲気・性格|基本)$/;
      return node.path.length > 2 && generic.test(node.label) ? node.path[node.path.length - 2] + ' / ' + node.label : node.label;
    }

    matches(value) {
      const matches = [...value.matchAll(references())];
      if ((value.match(/@/g) || []).length !== matches.length * 2) throw new Error('「@...@」の指定を確認してください。');
      return matches;
    }

    counts(spec, limit = 50) {
      const numbers = (spec || '1').split('-').map(Number);
      const min = Math.min(...numbers), max = Math.max(...numbers);
      if (!Number.isSafeInteger(max) || min < 0 || max > limit) throw new Error('プレビューは1参照につき50個まで対応しています。');
      return [min, max];
    }

    analyze(value) {
      if (this._analysis.has(value)) return this._analysis.get(value);
      const fixed = [], choices = [], metadata = [], randomFields = new Set();
      let random = false, visits = 0;
      const check = (text, stack, uncertain = false) => {
        if (++visits > 10000 || stack.length > 40) throw new Error('参照が多すぎるか、深すぎます。');
        const matches = this.matches(text);
        const literal = text.replace(references(), '');
        for (const token of tokens(literal)) {
          if (uncertain) { const field = tokenField(token); if (field) randomFields.add(field); }
          else fixed.push(token);
        }
        for (const match of matches) {
          const [min, max] = this.counts(match[1], Infinity);
          if (max === 0) continue;
          if (min !== max) random = true;
          const node = this.get(match[2]);
          walk(node, stack, uncertain || min !== max);
        }
      };
      const walk = (node, stack, uncertain) => {
        if (stack.includes(node.key)) throw new Error('参照が循環しています：' + node.key);
        const next = stack.concat(node.key);
        if (node.kind === 'group') {
          if (node.children.length > 1) random = true;
          choices.push(node);
          node.children.forEach(child => walk(child, next, uncertain || node.children.length > 1));
        } else {
          const meta = this.descriptions[node.key];
          if (!uncertain && meta && meta.value === node.value) metadata.push({ node, ...meta });
          check(node.value, next, uncertain);
        }
      };
      check(value, []);
      const result = {
        random, fixed: [...new Set(fixed)], randomFields: [...randomFields],
        choices: [...new Map(choices.map(n => [n.key, n])).values()],
        metadata: [...new Map(metadata.map(m => [m.node.key, m])).values()]
      };
      if (this._analysis.size >= 256) this._analysis.delete(this._analysis.keys().next().value);
      this._analysis.set(value, result);
      return result;
    }

    preview(value, rng = Math.random) {
      let visits = 0;
      const trace = [];
      const choose = (node, stack) => {
        if (++visits > 1000 || stack.length > 40) throw new Error('展開が多すぎるか、深すぎます。');
        if (stack.includes(node.key)) throw new Error('参照が循環しています：' + node.key);
        const next = stack.concat(node.key);
        if (node.kind === 'group') {
          const child = node.children[Math.min(node.children.length - 1, Math.floor(rng() * node.children.length))];
          if (child.kind === 'leaf') trace.push({ category: node.label, label: child.label, key: child.key });
          return choose(child, next);
        }
        return expand(node.value, next);
      };
      const expand = (text, stack) => {
        this.matches(text);
        return text.replace(references(), (_, spec, path) => {
          const [min, max] = this.counts(spec);
          const count = min + Math.floor(rng() * (max - min + 1));
          return Array.from({ length: count }, () => choose(this.get(path), stack)).join(', ');
        });
      };
      const analysis = this.analyze(value);
      return { text: expand(value, []), trace, random: analysis.random };
    }

    japanese(value) {
      return tokens(value).map(t => this.translations.get(normalize(t)) || t).join('、');
    }

    summary(node) {
      const meta = this.descriptions[node.key];
      if (meta && meta.value === node.value) return meta.description;
      if (node.kind === 'group') return node.children.length + '候補から選択';
      if (node.value.includes('@')) return '参照先の内容をまとめて追加';
      return this.japanese(node.value);
    }

    warnings(text) {
      const result = [], direct = new Set(), randomFields = new Set();
      try {
        const a = this.analyze(text);
        a.fixed.forEach(t => direct.add(normalize(t)));
        a.randomFields.forEach(f => randomFields.add(f));
      } catch (error) { result.push(error.message); }
      const frames = ['upper body', 'full body', 'cowboy shot', 'waist up', 'close-up', 'extreme close-up'].filter(t => direct.has(t));
      const gazes = ['looking at viewer', 'looking away', 'looking to the side', 'looking at book'].filter(t => direct.has(t));
      const poses = new Set([...direct].map(t => /^(standing|sitting|lying)(\b|$)/.exec(t)?.[1]).filter(Boolean));
      if ((direct.has('night') || direct.has('midnight')) && ['morning', 'day', 'noon', 'afternoon'].some(t => direct.has(t))) result.push('昼と夜の指定が一緒に入っています。');
      if (direct.has('indoors') && direct.has('outdoors')) result.push('室内と屋外の指定が一緒に入っています。');
      if (frames.length > 1) result.push('画角が複数指定されています：' + frames.map(t => this.japanese(t)).join('・'));
      if (gazes.length > 1) result.push('視線が複数指定されています。');
      if (poses.size > 1) result.push('立つ・座る・横になる指定が重なっています。');
      const directFields = new Set([...direct].map(tokenField).filter(Boolean));
      for (const field of randomFields) {
        if (directFields.has(field)) result.push(field + 'を含むランダム指定と、固定の' + field + 'が重なっています。');
      }
      const plain = tokens(text).filter(t => !t.includes('@'));
      const duplicates = [...new Set(plain.filter((t, i) => plain.findIndex(x => normalize(x) === normalize(t)) < i))];
      if (duplicates.length) result.push('同じ指定が重複しています：' + duplicates.slice(0, 3).map(t => this.japanese(t)).join('・'));
      return result.slice(0, 5);
    }
  }

  function boundary(text, start, end) {
    return /(?:^|,|\n)\s*$/.test(text.slice(0, start)) && /^\s*(?:,|\n|$)/.test(text.slice(end));
  }

  class PromptState {
    constructor(text = '', spans = []) {
      this.text = text;
      this.serial = 0;
      this.spans = spans.filter(s => typeof s.raw === 'string' && text.slice(s.start, s.end) === s.raw && boundary(text, s.start, s.end)).map(s => ({ ...s, id: ++this.serial }));
      this.history = new Map();
      this.remember();
    }

    remember() {
      if (this.text.length > 200000) return;
      this.history.delete(this.text);
      this.history.set(this.text, this.spans.map(s => ({ ...s })));
      if (this.history.size > 20) this.history.delete(this.history.keys().next().value);
    }

    sync(next) {
      if (this.text === next) return false;
      this.remember();
      const known = this.history.get(next);
      if (known) this.spans = known.map(s => ({ ...s, id: ++this.serial }));
      else {
        let prefix = 0, oldEnd = this.text.length, newEnd = next.length;
        while (prefix < Math.min(oldEnd, newEnd) && this.text[prefix] === next[prefix]) prefix++;
        while (oldEnd > prefix && newEnd > prefix && this.text[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
        const delta = newEnd - oldEnd;
        this.spans = this.spans.flatMap(span => {
          let adjusted;
          if (span.end <= prefix) adjusted = { ...span };
          else if (span.start >= oldEnd) adjusted = { ...span, start: span.start + delta, end: span.end + delta };
          else return [];
          return next.slice(adjusted.start, adjusted.end) === adjusted.raw && boundary(next, adjusted.start, adjusted.end) ? [adjusted] : [];
        });
      }
      this.text = next;
      this.remember();
      return true;
    }

    recover(catalog) {
      for (const match of this.text.matchAll(references())) {
        const start = match.index, end = start + match[0].length;
        if (!boundary(this.text, start, end) || this.spans.some(s => s.start < end && s.end > start)) continue;
        const node = catalog.nodes.get(match[2]);
        this.spans.push({ id: ++this.serial, start, end, raw: match[0], label: node ? catalog.displayName(node) : match[2], key: node?.key || '', mode: 'reference' });
      }
      this.spans.sort((a, b) => a.start - b.start);
      this.remember();
    }

    add(value, info = {}) {
      if (!value.trim()) throw new Error('追加する内容が空です。');
      const duplicate = this.spans.find(s => s.raw === value);
      if (duplicate) return { span: duplicate, duplicate: true };
      const prefix = !this.text.trim() ? '' : /[,\n]\s*$/.test(this.text) ? ' ' : ', ';
      const start = this.text.length + prefix.length;
      this.remember();
      this.text += prefix + value;
      const span = { ...info, id: ++this.serial, start, end: start + value.length, raw: value };
      this.spans.push(span);
      this.remember();
      return { span, duplicate: false };
    }

    requireSpan(id) {
      const span = this.spans.find(s => s.id === id);
      if (!span || this.text.slice(span.start, span.end) !== span.raw || !boundary(this.text, span.start, span.end)) throw new Error('本文が変更されています。選択中一覧から選び直してください。');
      return span;
    }

    remove(id) {
      const span = this.requireSpan(id);
      let { start, end } = span;
      const rightComma = /^\s*,\s*/.exec(this.text.slice(end));
      if (rightComma) end += rightComma[0].length;
      else {
        const leftComma = /,\s*$/.exec(this.text.slice(0, start));
        if (leftComma) start = leftComma.index;
      }
      const next = this.text.slice(0, start) + this.text.slice(end);
      this.sync(next);
      return next;
    }

    replace(id, value, info = {}) {
      if (!value.trim()) throw new Error('置き換える内容が空です。');
      const span = this.requireSpan(id), start = span.start;
      const next = this.text.slice(0, start) + value + this.text.slice(span.end);
      this.sync(next);
      this.spans = this.spans.filter(s => !(s.start < start + value.length && s.end > start));
      const replacement = { ...info, id: ++this.serial, start, end: start + value.length, raw: value };
      this.spans.push(replacement);
      this.spans.sort((a, b) => a.start - b.start);
      this.remember();
      return replacement;
    }

    untracked() {
      let remainder = this.text;
      [...this.spans].sort((a, b) => b.start - a.start).forEach(s => {
        remainder = remainder.slice(0, s.start) + remainder.slice(s.end);
      });
      return !!remainder.replace(/[\s,]/g, '');
    }

    snapshot() { return { text: this.text, spans: this.spans }; }
  }
  return { Catalog, PromptState, tokens, normalize, references, boundary };
});

/* Easy Prompt Selector: inspectable tags, references and live prompt selections. */
(function () {
  'use strict';
  const el = (tag, className = '', text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, action, className = 'eps-button') => {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const appendPairs = (parent, pairs) => {
    const list = el('dl', 'eps-pairs');
    for (const [name, value] of pairs) list.append(el('dt', '', name), el('dd', '', value));
    parent.append(list);
  };
  const details = (title, text) => {
    const node = el('details', 'eps-raw');
    node.append(el('summary', '', title), el('pre', '', text));
    return node;
  };

  class EasyPromptSelector {
    constructor() {
      this.Core = window.EPSCore;
      this.catalog = null;
      this.toNegative = false;
      this.visible = false;
      this.states = [new this.Core.PromptState(), new this.Core.PromptState()];
      this.inputs = [null, null];
      this.handlers = [null, null];
      this.current = null;
      this.replacement = null;
      this.hoverTimer = null;
      this.refreshTimer = null;
      this.persistTimer = null;
      this.generation = 0;
      this.file = '';
      this.restored = false;
    }

    app() { return gradioApp(); }
    textarea(negative) { return this.app().querySelector((negative ? '#txt2img_neg_prompt' : '#txt2img_prompt') + ' textarea'); }
    state(negative) { return this.states[negative ? 1 : 0]; }

    notify(message, error = false) {
      if (!this.status) return;
      this.status.textContent = message;
      this.status.classList.toggle('eps-error', error);
      this.status.setAttribute('role', error ? 'alert' : 'status');
    }

    async read(path, optional = false) {
      const response = await fetch('file=' + path + '?eps=' + Date.now(), { cache: 'no-store' });
      if (optional && response.status === 404) return null;
      if (!response.ok) throw new Error('読み込めませんでした：' + path + ' (' + response.status + ')');
      return response.text();
    }

    async load() {
      const manifest = await this.read('tmp/easyPromptSelector.txt');
      const paths = manifest.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const files = await Promise.all(paths.map(async path => {
        try {
          const filename = path.split('/').pop().replace(/\.yml$/i, '');
          const documents = [];
          window.jsyaml.loadAll(await this.read(path), doc => { if (doc != null) documents.push(doc); });
          if (documents.length !== 1) throw new Error('YAML文書は1ファイルに1つにしてください。');
          const data = { [filename]: documents[0] };
          new this.Core.Catalog(data);
          return { filename, data: documents[0] };
        } catch (error) { return { error: path + '：' + error.message }; }
      }));
      const tags = Object.create(null), errors = [], duplicates = new Set();
      files.forEach(file => {
        if (file.error) errors.push(file.error);
        else if (Object.prototype.hasOwnProperty.call(tags, file.filename)) {
          duplicates.add(file.filename);
          errors.push('同じファイル名が複数あります：' + file.filename);
        } else tags[file.filename] = file.data;
      });
      duplicates.forEach(name => delete tags[name]);
      let descriptions = {};
      const first = paths.find(p => p.includes('/tags/'));
      if (first) {
        try {
          const text = await this.read(first.slice(0, first.indexOf('/tags/')) + '/ui_descriptions.json', true);
          if (text) {
            const content = JSON.parse(text);
            if (content.version !== 1 || !content.items || typeof content.items !== 'object') throw new Error('説明データの形式が違います。');
            descriptions = Object.fromEntries(Object.entries(content.items).filter(([, meta]) =>
              meta && typeof meta.value === 'string' && typeof meta.description === 'string' &&
              (!meta.parts || (Array.isArray(meta.parts) && meta.parts.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string'))))
            ));
          }
        } catch (error) { errors.push('補足説明：' + error.message); }
      }
      return { catalog: new this.Core.Catalog(tags, descriptions), errors };
    }

    async init() {
      const version = ++this.generation;
      try {
        const loaded = await this.load();
        if (version !== this.generation) return;
        this.catalog = loaded.catalog;
        this.loadErrors = loaded.errors;
        this.bindInputs();
        this.build();
        this.syncAll(true);
        this.showFile(this.file || Object.keys(this.catalog.tags)[0] || '');
        this.notify('読み込み完了。名前で追加、詳細ボタンやマウスを重ねて内容を確認できます。');
      } catch (error) {
        if (!this.root) { this.catalog = new this.Core.Catalog({}); this.loadErrors = [error.message]; this.build(); }
        this.notify(error.message + '。「🔄」で再読み込みできます。', true);
      }
    }

    bindInputs() {
      if (!this.restored) {
        try {
          const saved = JSON.parse(sessionStorage.getItem('easy-prompt-selector:selections:v1') || 'null');
          if (saved?.version === 1 && Array.isArray(saved.prompts)) {
            saved.prompts.slice(0, 2).forEach((s, i) => {
              if (typeof s.text === 'string' && Array.isArray(s.spans)) this.states[i] = new this.Core.PromptState(s.text, s.spans);
            });
            if (typeof saved.file === 'string') this.file = saved.file;
          }
        } catch (_) { /* Browser storage may be unavailable. */ }
        this.restored = true;
      }
      [false, true].forEach(negative => {
        const i = Number(negative), input = this.textarea(negative);
        if (!input || input === this.inputs[i]) return;
        if (this.inputs[i]) {
          this.inputs[i].removeEventListener('input', this.handlers[i]);
          this.inputs[i].removeEventListener('change', this.handlers[i]);
        }
        this.inputs[i] = input;
        this.handlers[i] = () => {
          this.syncAll();
          if (this.current?.selection) this.refreshSelectionDetail();
        };
        input.addEventListener('input', this.handlers[i]);
        input.addEventListener('change', this.handlers[i]);
      });
    }

    persist() {
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        try {
          const value = JSON.stringify({ version: 1, file: this.file, prompts: this.states.map(s => s.snapshot()) });
          if (value.length < 500000) sessionStorage.setItem('easy-prompt-selector:selections:v1', value);
        } catch (_) { /* A storage error must not affect the prompt. */ }
      }, 150);
    }

    syncAll(force = false) {
      if (!this.catalog) return;
      this.bindInputs();
      let changed = force;
      [false, true].forEach(negative => {
        const input = this.textarea(negative);
        if (!input) return;
        const state = this.state(negative);
        const count = state.spans.length;
        changed = state.sync(input.value) || changed;
        state.recover(this.catalog);
        changed = changed || count !== state.spans.length;
      });
      if (this.replacement && !this.state(this.replacement.negative).spans.some(s => s.id === this.replacement.id)) {
        this.replacement = null;
        this.renderReplacement();
      }
      if (changed) { this.renderSelections(); this.renderPressed(); this.persist(); }
    }

    commit(negative) {
      const input = this.textarea(negative);
      if (!input) throw new Error('プロンプト欄が見つかりません。');
      input.value = this.state(negative).text;
      if (typeof updateInput === 'function') updateInput(input);
      else input.dispatchEvent(new Event('input', { bubbles: true }));
      this.syncAll(true);
    }

    target(event) { return !!(this.toNegative || event?.ctrlKey || event?.metaKey); }

    insert(entry, event, fixed = null) {
      try {
        this.syncAll();
        const negative = this.replacement ? this.replacement.negative : this.target(event);
        if (!this.textarea(negative)) throw new Error('プロンプト欄が見つかりません。');
        const state = this.state(negative), value = fixed ? fixed.text : entry.value;
        this.catalog.analyze(value);
        const info = { label: entry.selectionLabel || entry.label, key: entry.key || '', mode: fixed ? 'fixed' : 'added', trace: fixed?.trace || [], source: entry.value };
        let added;
        if (this.replacement) {
          added = state.replace(this.replacement.id, value, info);
          this.replacement = null;
          this.renderReplacement();
        } else {
          const result = state.add(value, info);
          if (result.duplicate) { this.notify('同じ内容は既に追加されています。'); return; }
          added = result.span;
        }
        this.commit(negative);
        this.inspectSpan(negative, added.id);
        this.notify(entry.label + (fixed ? '：表示中の展開例で固定しました。' : 'を' + (negative ? 'ネガティブ' : 'ポジティブ') + 'に追加しました。'));
      } catch (error) { this.notify(error.message, true); }
    }

    remove(negative, id) {
      try {
        this.syncAll();
        const state = this.state(negative), span = state.requireSpan(id);
        state.remove(id);
        this.commit(negative);
        this.notify(span.label + 'を外しました。');
        this.refreshSelectionDetail();
      } catch (error) { this.notify(error.message, true); }
    }

    removeValue(entry, event) {
      this.syncAll();
      const negative = this.target(event), state = this.state(negative);
      const span = [...state.spans].reverse().find(s => s.raw === entry.value);
      if (span) this.remove(negative, span.id);
      else this.notify('一致する選択項目がありません。手入力した内容は本文から編集してください。');
    }

    build() {
      this.root?.remove();
      this.current = null;
      this.replacement = null;
      this.root = el('section', 'eps-root');
      this.root.id = 'easy-prompt-selector';
      this.root.hidden = !this.visible;
      const toolbar = el('div', 'eps-toolbar');
      const label = el('label', 'eps-file-label', 'タグファイル');
      this.select = el('select', 'eps-select');
      this.select.id = 'easy-prompt-selector-select';
      Object.keys(this.catalog.tags).forEach(name => {
        const option = el('option', '', name); option.value = name; this.select.append(option);
      });
      label.append(this.select);
      this.select.addEventListener('change', () => this.showFile(this.select.value));
      const negative = el('label', 'eps-negative-label');
      this.negativeCheck = el('input');
      this.negativeCheck.type = 'checkbox';
      this.negativeCheck.checked = this.toNegative;
      this.negativeCheck.addEventListener('change', () => {
        this.toNegative = this.negativeCheck.checked;
        this.renderPressed();
        this.renderDetail();
      });
      negative.append(this.negativeCheck, document.createTextNode('ネガティブプロンプトに入力'));
      toolbar.append(label, negative);
      this.root.append(toolbar);
      if (this.loadErrors?.length) {
        const errors = el('details', 'eps-load-errors');
        errors.append(el('summary', '', this.loadErrors.length + '件の読み込み問題'));
        this.loadErrors.forEach(message => errors.append(el('p', '', message)));
        this.root.append(errors);
      }
      this.selectedArea = el('div', 'eps-selected-area');
      this.selectedArea.setAttribute('aria-label', '現在のプロンプトに含まれる選択項目');
      this.replacementArea = el('div', 'eps-replacement');
      this.replacementArea.hidden = true;
      this.root.append(this.selectedArea, this.replacementArea);
      const body = el('div', 'eps-body');
      this.content = el('div', 'eps-catalog');
      this.content.id = 'easy-prompt-selector-content';
      this.inspector = el('aside', 'eps-inspector');
      this.inspector.setAttribute('aria-label', 'タグの内容');
      body.append(this.content, this.inspector);
      this.root.append(body);
      this.status = el('div', 'eps-status');
      this.status.setAttribute('aria-live', 'polite');
      this.root.append(this.status);
      this.app().querySelector('#txt2img_toprow').after(this.root);
      this.renderDetail();
    }

    showFile(name) {
      if (!Object.prototype.hasOwnProperty.call(this.catalog.tags, name)) name = Object.keys(this.catalog.tags)[0] || '';
      this.file = name;
      this.select.value = name;
      this.content.replaceChildren();
      const root = this.catalog.nodes.get(name);
      if (root) {
        if (root.kind === 'leaf') this.content.append(this.renderNode(root));
        else root.children.forEach(node => this.content.append(this.renderNode(node)));
      } else this.content.append(el('p', 'eps-muted', 'タグがありません。読み込み問題を確認してください。'));
      this.renderPressed();
      this.persist();
    }

    entry(node) { return { key: node.key, label: node.label, selectionLabel: this.catalog.displayName(node), value: this.catalog.input(node), node }; }

    renderNode(node, depth = 0) {
      if (node.kind === 'leaf') return this.tagControl(this.entry(node));
      if (depth > 40) return el('p', 'eps-error', 'カテゴリの階層が深すぎます。');
      const group = el('section', 'eps-group');
      const heading = el('div', 'eps-group-heading');
      heading.append(el('h3', '', node.label));
      heading.append(this.tagControl(this.entry(node), true));
      const children = el('div', 'eps-group-items');
      node.children.forEach(child => children.append(this.renderNode(child, depth + 1)));
      group.append(heading, children);
      return group;
    }

    tagControl(entry, group = false) {
      const wrapper = el('span', 'eps-tag-control');
      const tag = button(group ? '🎲 選ぶ' : entry.label, event => this.insert(entry, event), 'eps-tag' + (group ? ' eps-random' : ''));
      tag.dataset.epsKey = entry.key;
      tag.setAttribute('aria-label', group ? entry.label + 'からランダム選択' : entry.label);
      tag.title = (group ? '候補から1項目を選択' : entry.value);
      tag.addEventListener('pointerenter', () => {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => this.inspect(entry), 220);
      });
      tag.addEventListener('pointerleave', () => clearTimeout(this.hoverTimer));
      tag.addEventListener('focus', () => this.inspect(entry));
      tag.addEventListener('contextmenu', event => { event.preventDefault(); this.removeValue(entry, event); });
      const info = button('詳細', () => { this.inspect(entry); if (matchMedia('(max-width: 800px)').matches) this.inspector.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 'eps-info');
      info.setAttribute('aria-label', entry.label + 'の詳細');
      wrapper.append(tag, info);
      return wrapper;
    }

    renderPressed() {
      if (!this.content) return;
      const keys = new Set(this.state(this.toNegative).spans.filter(s => s.mode !== 'fixed').map(s => s.key));
      this.content.querySelectorAll('[data-eps-key]').forEach(node => node.setAttribute('aria-pressed', String(keys.has(node.dataset.epsKey))));
    }

    renderSelections() {
      if (!this.selectedArea) return;
      this.selectedArea.replaceChildren();
      [false, true].forEach(negative => {
        const state = this.state(negative);
        const section = el('section', 'eps-selection');
        section.append(el('h3', '', negative ? '選択中 · ネガティブ' : '選択中 · ポジティブ'));
        const row = el('div', 'eps-chips');
        state.spans.forEach(span => {
          const chip = el('span', 'eps-chip');
          let mode = 'セット';
          try { mode = span.mode === 'fixed' ? '固定した例' : this.catalog.analyze(span.raw).random ? 'ランダムを含む' : '固定'; } catch (_) { mode = '要確認'; }
          const show = button(span.label + ' · ' + mode, () => this.inspectSpan(negative, span.id), 'eps-chip-name');
          const remove = button('×', () => this.remove(negative, span.id), 'eps-chip-remove');
          remove.setAttribute('aria-label', span.label + 'を' + (negative ? 'ネガティブ' : 'ポジティブ') + 'から外す');
          chip.append(show, remove); row.append(chip);
        });
        if (!state.spans.length) row.append(el('span', 'eps-muted', '選択した項目はここに表示されます。'));
        section.append(row);
        if (state.untracked()) section.append(el('p', 'eps-untracked', '手入力・編集済みなどの未分類部分があります。本文の内容は保持しています。'));
        if (!negative) {
          const notices = this.catalog.warnings(state.text);
          if (state.spans.filter(s => /キャラクタープリセット:[^:]+:フルセット$/.test(s.key)).length > 1) notices.push('1人用のキャラセットが複数選ばれています。');
          if (notices.length) {
            const warning = el('div', 'eps-warning');
            warning.setAttribute('role', 'status');
            notices.forEach(message => warning.append(el('p', '', message)));
            section.append(warning);
          }
        }
        this.selectedArea.append(section);
      });
    }

    inspect(entry, selection = null) {
      clearTimeout(this.hoverTimer);
      let preview, analysis, error = '';
      try {
        analysis = this.catalog.analyze(entry.value);
        preview = this.catalog.preview(entry.value);
      } catch (e) { error = e.message; }
      this.current = { entry, selection, preview, analysis, error };
      this.renderDetail();
    }

    inspectSpan(negative, id) {
      try {
        this.syncAll();
        const span = this.state(negative).requireSpan(id);
        const node = this.catalog.nodes.get(span.key);
        this.toNegative = negative;
        this.negativeCheck.checked = negative;
        this.inspect({ key: span.key, label: span.label, value: span.raw, node, savedTrace: span.trace || [], fixed: span.mode === 'fixed' }, { negative, id });
        this.renderPressed();
      } catch (error) { this.notify(error.message, true); }
    }

    refreshSelectionDetail() {
      const selection = this.current?.selection;
      if (!selection) return;
      if (!this.state(selection.negative).spans.some(s => s.id === selection.id)) {
        this.current = null;
        this.renderDetail();
      }
    }

    renderReplacement() {
      if (!this.replacementArea) return;
      this.replacementArea.hidden = !this.replacement;
      this.replacementArea.replaceChildren();
      if (!this.replacement) return;
      const span = this.state(this.replacement.negative).spans.find(s => s.id === this.replacement.id);
      this.replacementArea.append(el('span', '', '差し替え対象：' + (span?.label || '') + '。入れ替えるタグを選んでください。'));
      this.replacementArea.append(button('キャンセル', () => { this.replacement = null; this.renderReplacement(); }));
    }

    renderDetail() {
      if (!this.inspector) return;
      this.inspector.replaceChildren();
      if (!this.current) {
        this.inspector.append(el('h3', '', 'タグの内容'), el('p', 'eps-muted', 'タグにマウスを重ねるか「詳細」を押すと、内容やランダム候補を確認できます。'));
        return;
      }
      const { entry, selection, preview, analysis, error } = this.current;
      const heading = el('div', 'eps-detail-heading');
      heading.append(el('h3', '', entry.label), el('span', 'eps-badge' + (analysis?.random ? ' eps-badge-random' : ''), error ? '要確認' : entry.fixed ? '固定した例' : analysis?.random ? 'ランダムを含む' : '固定'));
      this.inspector.append(heading, el('div', 'eps-breadcrumb', entry.key.split(':').slice(0, -1).join(' › ')));
      if (error) this.inspector.append(el('p', 'eps-error', error));
      const ownMeta = this.catalog.descriptions[entry.key];
      const meta = ownMeta && ownMeta.value === entry.value ? ownMeta : null;
      if (meta) {
        this.inspector.append(el('p', 'eps-description', meta.description));
        if (Array.isArray(meta.parts)) appendPairs(this.inspector, meta.parts);
      } else if (!analysis?.random && !entry.fixed && !error) {
        this.inspector.append(el('p', 'eps-description', this.catalog.japanese(entry.value)));
      }
      if (entry.node?.kind === 'group' && entry.node.children.some(n => n.label === 'フルセット')) {
        this.inspector.append(el('p', 'eps-warning', 'このカテゴリはフルセット・髪型などから1項目を選びます。キャラを固定したい場合は「フルセット」を選んでください。'));
      }
      if (analysis && !meta) {
        for (const m of analysis.metadata.slice(0, 3)) {
          const section = el('details', 'eps-meta-section');
          section.append(el('summary', '', m.node.path.slice(-2).join(' · ') + 'の内容'));
          appendPairs(section, m.parts || [['説明', m.description]]);
          this.inspector.append(section);
        }
      }
      if (analysis?.random) {
        const fixed = analysis.fixed;
        if (fixed.length) {
          if (fixed.join(', ').length <= 250) appendPairs(this.inspector, [['固定条件', this.catalog.japanese(fixed.join(', '))]]);
          else this.inspector.append(details('固定される内容を見る', this.catalog.japanese(fixed.join(', '))));
        }
        const candidates = el('details', 'eps-candidate-section');
        candidates.append(el('summary', '', 'ランダム候補を確認 · ' + analysis.choices.length + 'カテゴリ'));
        analysis.choices.forEach(group => {
          const part = el('details', 'eps-candidate-group');
          part.append(el('summary', '', group.label + ' · ' + group.children.length + '候補'));
          group.children.forEach(child => {
            const pick = button(child.label, () => this.inspect(this.entry(child)), 'eps-candidate-link');
            part.append(pick);
          });
          candidates.append(part);
        });
        this.inspector.append(candidates);
      }
      const trace = entry.fixed ? entry.savedTrace : preview?.trace || [];
      if (analysis?.random || entry.fixed) {
        const sample = el('section', 'eps-sample');
        const head = el('div', 'eps-sample-heading');
        head.append(el('h4', '', entry.fixed ? '固定した組み合わせ' : '展開例'));
        if (analysis?.random && !error) head.append(button('別の例', () => {
          try { this.current.preview = this.catalog.preview(entry.value); this.renderDetail(); this.notify('展開例を切り替えました。本文は変更していません。'); }
          catch (e) { this.notify(e.message, true); }
        }));
        sample.append(head);
        if (!entry.fixed) sample.append(el('p', 'eps-muted', '生成時の抽選結果とは別の例です。'));
        if (trace.length) appendPairs(sample, trace.slice(0, 80).map(t => [t.category, t.label]));
        else sample.append(el('p', '', '英語タグで展開内容を確認できます。'));
        if (trace.length > 80) sample.append(el('p', 'eps-muted', '選択履歴は先頭80件を表示しています。展開された英語タグは全文を確認できます。'));
        if (preview) sample.append(details('展開例の英語タグ', preview.text));
        this.inspector.append(sample);
      }
      const actions = el('div', 'eps-detail-actions');
      const add = button((analysis?.random ? 'ランダムのまま' : '') + (this.toNegative ? 'ネガティブへ追加' : '追加'), event => this.insert(entry, event), 'eps-button eps-primary');
      add.disabled = !!error && !analysis; actions.append(add);
      if (analysis?.random && preview) {
        const fixed = button(selection ? 'この例で置き換えて固定' : 'この例を固定して追加', event => {
          if (selection) { this.replacement = { ...selection }; this.renderReplacement(); }
          this.insert(entry, event, preview);
        });
        fixed.disabled = !!error || !preview.text.trim(); actions.append(fixed);
      }
      if (selection) {
        actions.append(button('別のタグに差し替え', () => {
          this.syncAll();
          try { this.state(selection.negative).requireSpan(selection.id); this.replacement = { ...selection }; this.renderReplacement(); }
          catch (e) { this.notify(e.message, true); }
        }));
      }
      this.inspector.append(actions, details('追加する指定を全文で見る', entry.value));
    }

    toggle() {
      this.visible = !this.visible;
      if (this.root) this.root.hidden = !this.visible;
      this.openButton?.setAttribute('aria-expanded', String(this.visible));
      if (this.visible) this.syncAll();
    }

    start() {
      const actions = this.app().querySelector('#txt2img_actions_column');
      const reload = this.app().querySelector('#easy_prompt_selector_reload_button');
      if (!actions || !reload || !this.app().querySelector('#txt2img_toprow')) return;
      const container = el('div', 'easy_prompt_selector_container');
      this.openButton = button('🔯 タグを選択', () => this.toggle(), 'easy_prompt_selector_button eps-open-button');
      this.openButton.setAttribute('aria-controls', 'easy-prompt-selector');
      this.openButton.setAttribute('aria-expanded', 'false');
      container.append(this.openButton, reload);
      actions.append(container);
      reload.addEventListener('click', () => {
        clearTimeout(this.refreshTimer);
        // Let the existing Gradio reload callback update the filename manifest.
        this.refreshTimer = setTimeout(() => this.init(), 600);
      });
      this.init();
      this.poll = setInterval(() => {
        if (this.visible && !document.hidden) {
          const changed = [false, true].some(n => this.textarea(n)?.value !== this.state(n).text);
          if (changed) { this.syncAll(); this.refreshSelectionDetail(); }
        }
      }, 800);
      window.addEventListener('pagehide', () => { clearInterval(this.poll); clearTimeout(this.refreshTimer); clearTimeout(this.hoverTimer); });
    }
  }
  if (typeof onUiLoaded === 'function') onUiLoaded(() => {
    if (!window.EPSCore || !window.jsyaml) {
      console.error('Easy Prompt Selector: required JavaScript was not loaded.');
      return;
    }
    new EasyPromptSelector().start();
  });
})();
