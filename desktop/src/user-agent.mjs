// Single source of truth for the outbound User-Agent on every external call from the
// desktop app (ESI, eve-kill killboard, eve-kill MCP, EVE-Scout, EVE Ref, the model
// catalog on GitHub/HuggingFace, and model/index downloads).
//
// WHY — third-party EVE service operators (CCP/ESI, eve-kill, EVE Ref, EVE-Scout) ask
// callers to identify themselves so they can reach out if an app misbehaves. The default
// fetch UA tells them nothing. This string answers "who is calling and how to reach them":
// app name + version + site + contact email, in CCP's recommended ESI format
// `App/version (+url; contact)`. The version is read from package.json so it tracks the
// release automatically. Keep this the SINGLE source — every external fetch imports it.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export const USER_AGENT = `Capsuleers.IA/${version} (+https://capsuleers.app; info@capsuleers.app)`;
