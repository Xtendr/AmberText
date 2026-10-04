import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/editor.css";
import "./styles/prose.css";
import "./styles/ai.css";
import { App } from "./App";
import { boot } from "./state/actions";

boot().finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
