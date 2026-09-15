// Registers a resolve hook so Node's --experimental-strip-types can load app
// TypeScript modules that use extension-less relative imports (Metro style).
import { register } from "node:module";

register("./ts-resolver-hooks.mjs", import.meta.url);
