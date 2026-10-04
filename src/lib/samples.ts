export const WELCOME_TITLE = "Welcome to Margin";

export const WELCOME_DOC = `# Welcome to Margin

Margin is a quiet place to write. What you see is *styled*, but underneath it is always **plain Markdown** — portable, future‑proof, and yours.

Move your cursor into any styled text and its syntax gently reappears. Move away and it gets out of your way again.

## The essentials

- Press **/** at the start of a line to insert headings, tables, diagrams and more
- Select text to reveal the formatting toolbar
- Press **Ctrl P** to jump to any file, or **Ctrl Shift P** for every command
- Switch between **Write**, **Split** and **Read** in the title bar

> [!TIP]
> Turn on *Focus mode* with **Ctrl Shift F** — everything except the paragraph you're writing softly fades away.

## Make it yours

Open **Settings** with **Ctrl ,** to choose a typeface, accent colour, line width and theme. Changes apply instantly, so you can tune the page while you look at it.

- [x] Open Margin
- [ ] Write something you care about
- [ ] Try the three typefaces: *Serif*, *Sans* and *Mono*

## Everything Markdown can do

| Element      | Syntax              | Renders as       |
| ------------ | ------------------- | ---------------- |
| Bold         | \`**text**\`          | **text**         |
| Italic       | \`_text_\`            | _text_           |
| Code         | \`\` \`code\` \`\`        | \`code\`           |
| Strike       | \`~~text~~\`          | ~~text~~         |

Code blocks are highlighted for over a hundred languages:

\`\`\`ts
function greet(name: string) {
  return \`Hello, \${name} — welcome to Margin.\`;
}
\`\`\`

Math is typeset with KaTeX:

$$
e^{i\\pi} + 1 = 0
$$

And diagrams are drawn from text with Mermaid:

\`\`\`mermaid
flowchart LR
  Idea --> Draft --> Edit --> Publish
\`\`\`

> [!NOTE]
> Callouts use GitHub's syntax, so your documents look right everywhere.

---

When you're ready, press **Ctrl N** to start a new document, or **Ctrl Shift O** to open a folder of notes. Happy writing.
`;

export const DEMO_FILES: Record<string, string> = {
  "Welcome.md": WELCOME_DOC,
  "Journal/2026-10-04.md": `# Sunday, October 4

Slow morning. Coffee, rain on the window, and finally some time to think about the new project.

## Ideas worth keeping

- A writing app that feels like **good paper**
- Interfaces that _recede_ while you work
- Typography as the primary interface

> The details are not the details. They make the design.
> — Charles Eames
`,
  "Journal/2026-10-02.md": `# Friday, October 2

Shipped the first prototype. It's rough, but the core loop feels right.
`,
  "Projects/Margin roadmap.md": `# Margin roadmap

## Now
- [x] Live preview editor
- [x] Command palette
- [ ] Publishing integrations

## Later
- [ ] Sync across devices
- [ ] Collaborative comments
`,
  "Projects/Design principles.md": `# Design principles

1. **Calm by default.** The interface should never compete with the words.
2. **Honest materials.** Plain text underneath, always.
3. **Delight in the details.** Motion, rhythm and type deserve as much care as features.
`,
  "Reading list.md": `# Reading list

- *The Elements of Typographic Style* — Robert Bringhurst
- *Thinking with Type* — Ellen Lupton
- *Designing Design* — Kenya Hara
`,
};
