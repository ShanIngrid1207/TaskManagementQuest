import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The task app auto-caps free text on save (App.utils.upper). Web addresses are
// case-sensitive past the domain — uppercasing a Drive/Dropbox/YouTube id points
// the link at a different (non-existent) file — so links must survive the caps.
const utilsSource = readFileSync(new URL('../../js/utils.js', import.meta.url), 'utf8');

function loadUtils() {
  const App = {};
  const context = { App, console, window: { App } };
  vm.runInNewContext(utilsSource, context, { filename: 'utils.js' });
  return App.utils;
}

test('auto-caps keeps a pasted web address in its original capitalization', () => {
  const utils = loadUtils();
  const out = utils.upper('photos are here https://drive.google.com/file/d/aBc123XyZ/view thanks');
  assert.equal(out, 'PHOTOS ARE HERE https://drive.google.com/file/d/aBc123XyZ/view THANKS');
});

test('auto-caps keeps a bare www address in its original capitalization', () => {
  const utils = loadUtils();
  assert.equal(utils.upper('see www.Example.com/Path today'), 'SEE www.Example.com/Path TODAY');
});

test('auto-caps keeps an email address in its original capitalization', () => {
  const utils = loadUtils();
  assert.equal(utils.upper('email bob.Smith@Example.com now'), 'EMAIL bob.Smith@Example.com NOW');
});

test('auto-caps still shouts ordinary text', () => {
  const utils = loadUtils();
  assert.equal(utils.upper('call bob about the roof quote'), 'CALL BOB ABOUT THE ROOF QUOTE');
});

test('auto-caps is idempotent on text containing a link', () => {
  const utils = loadUtils();
  const once = utils.upper('proof at https://a.co/xY thanks');
  assert.equal(utils.upper(once), once);
});

test('task text renders a pasted web address as a clickable link', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('SEE https://drive.google.com/file/d/aBc123XyZ/view NOW');
  assert.match(html, /<a href="https:\/\/drive\.google\.com\/file\/d\/aBc123XyZ\/view" target="_blank" rel="noopener noreferrer">/);
});

test('task text renders a bare www address as a clickable https link', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('SEE www.example.com/path');
  assert.match(html, /<a href="https:\/\/www\.example\.com\/path"/);
});

test('task text renders an email address as a mailto link', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('EMAIL bob@example.com');
  assert.match(html, /<a href="mailto:bob@example\.com"/);
});

test('linkified task text still escapes HTML', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('<img src=x onerror="alert(1)"> https://a.co/b');
  assert.ok(!html.includes('<img'), 'raw markup must not survive');
  assert.ok(!html.includes('onerror="'), 'attributes must not survive');
  assert.match(html, /&lt;img/);
});

test('linkify refuses a javascript: url', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('javascript:alert(1)');
  assert.ok(!/<a /.test(html), 'javascript: must never become a link');
});

test('linkify applies a caller transform to plain text only, never inside a link', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('ASK @bob about https://a.co/x@y', s => s.replace(/@(\w+)/g, '<b>@$1</b>'));
  assert.match(html, /<b>@bob<\/b>/);
  assert.ok(!html.includes('<b>@y'), 'the transform must not reach inside an anchor');
  assert.match(html, /href="https:\/\/a\.co\/x@y"/);
});

const detailSource = readFileSync(
  new URL('../../js/views/TaskDetailView.js', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

test('the task brief renders its addresses as clickable links', () => {
  const brief = detailSource.split('\n').find(line => line.includes('class="detail-desc td2-brief-body"'));
  assert.ok(brief, 'the brief row must exist');
  assert.match(brief, /App\.utils\.linkifyText\(t\.description/);
});

test('clicking a link in the brief opens the link, not the inline editor', () => {
  const at = detailSource.indexOf("const descText = q('[data-edit-field=\"description\"]')");
  assert.notEqual(at, -1, 'the brief click binding must exist');
  const binding = detailSource.slice(at, at + 400);
  assert.match(binding, /closest\('a'\)/);
});

test('comment bodies render their addresses as clickable links', () => {
  const at = detailSource.indexOf('_commentRow(c) {');
  assert.notEqual(at, -1, 'the comment renderer must exist');
  const body = detailSource.slice(at, detailSource.indexOf('const tagHtml', at));
  assert.match(body, /App\.utils\.linkifyText\(raw/);
  assert.match(body, /cm-at/);
});

const cssSource = readFileSync(
  new URL('../../taskmanagement.css', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

test('links in task free text read as links rather than browser blue', () => {
  assert.match(cssSource, /\.detail-desc a,\n\.cm-text a \{[^}]*var\(--accent/);
});

test('a link ending a bracketed sentence keeps neither the bracket nor the period', () => {
  const utils = loadUtils();
  assert.match(utils.linkifyText('(SEE https://a.co/b.)'), /href="https:\/\/a\.co\/b"/);
});

test('a link that legitimately ends in a bracket keeps it', () => {
  const utils = loadUtils();
  assert.match(
    utils.linkifyText('WIKI https://en.wikipedia.org/wiki/Foo_(bar)'),
    /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/,
  );
});

// --- Rescuing links mangled before the auto-caps fix -------------------------
// Everything saved between the auto-caps feature and its fix is stored fully
// uppercased. Nobody types a link that way, so an all-caps address is a
// reliable tell that the old code mangled it — open it in lowercase. Display
// only: the stored value is never rewritten.

test('a legacy all-caps link opens in lowercase', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('LINK FOR THE DESIGNS: HTTPS://LUMEN-MARKETING.GITHUB.IO/ZWINDOW-DESIGNS/');
  assert.match(html, /href="https:\/\/lumen-marketing\.github\.io\/zwindow-designs\/"/);
});

test('a legacy all-caps link is also shown in lowercase, so it can be copied', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('SEE HTTPS://A.CO/B');
  assert.match(html, />https:\/\/a\.co\/b</);
});

test('a legacy all-caps email opens as a lowercase mailto', () => {
  const utils = loadUtils();
  assert.match(utils.linkifyText('EMAIL BOB@EXAMPLE.COM'), /href="mailto:bob@example\.com"/);
});

test('a link with real mixed capitalization is never touched', () => {
  const utils = loadUtils();
  const html = utils.linkifyText('SEE https://drive.google.com/file/d/aBc123XyZ/view');
  assert.match(html, /href="https:\/\/drive\.google\.com\/file\/d\/aBc123XyZ\/view"/);
});

test('rescuing is display-only: auto-caps never rewrites a stored link', () => {
  const utils = loadUtils();
  assert.equal(utils.upper('see HTTPS://A.CO/B now'), 'SEE HTTPS://A.CO/B NOW');
});
