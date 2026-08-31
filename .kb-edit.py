import sys

ROOT = '/home/callmesoul/code/deepseek-kanban-plugin'

def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

def patch(p, old, new):
    s = read(p)
    if old not in s:
        print('MISS ' + p)
        print('OLD ' + repr(old[:160]))
        return False
    write(p, s.replace(old, new, 1))
    print('OK   ' + p)
    return True

ok = True

ok = patch(
    ROOT + '/src/lib/markdown.ts',
    "    ADD_DATA_URI_TAGS: ['img'],\n",
    "    ADD_DATA_URI_TAGS: ['img'],\n" + r"    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i," + "\n",
) and ok

old2 = "\n".join([
    "  const label = name.replace(/[[\\]]/g, '');",
    r"  const md = `[${label}](<file://${path}>)`;",
])
new2 = "\n".join([
    "  const label = name.replace(/[[\\]]/g, '');",
    r'''  const title = path.replace(/"/g, '').replace(/\s+/g, ' ').trim();''',
    r'''  const md = `[${label}](<file://${path}> "${title}")`;''',
])
ok = patch(ROOT + '/src/components/MarkdownEditor.vue', old2, new2) and ok

old3 = "\n".join([
    ":where(.dsh-kanban-root) .markdown-body a {",
    "  color: var(--primary);",
    "  text-decoration: underline;",
    "  text-underline-offset: 2px;",
    "}",
])
new3_lines = [
    "/* File attachment badge: pasted file:// links render as a pill */",
    ':where(.dsh-kanban-root) a[href^="file:"] {',
    "  display: inline-flex;",
    "  align-items: center;",
    "  max-width: 100%;",
    "  margin: 0 0.15em;",
    "  padding: 0.1em 0.55em;",
    "  font-size: 0.75rem;",
    "  line-height: 1.5;",
    "  color: var(--foreground);",
    "  background: var(--muted);",
    "  border: 1px solid var(--border);",
    "  border-radius: 9999px;",
    "  text-decoration: none;",
    "  cursor: help;",
    "  white-space: nowrap;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "  vertical-align: middle;",
    "}",
]
ok = patch(ROOT + '/src/assets/index.css', old3, old3 + "\n" + "\n".join(new3_lines)) and ok

old4 = "    .replace(/!\\[[^\\]]*\\]\\(data:[^)]*\\)/gi, "
new4 = r'''    .replace(/\[[^\]]*\]\(<file:\/\/([^>]*)>(?:\s+"[^"]*")?\)/gi, '$1')''' + "\n" + old4
ok = patch(ROOT + '/lib/index.js', old4, new4) and ok

if not ok:
    sys.exit(1)
print('ALL DONE')