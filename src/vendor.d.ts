declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
}

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const mark: MarkdownIt.PluginSimple;
  export default mark;
}
