// `npm run dev`: the API on 8788 and Vite on 5173, one command.
import { spawn } from "node:child_process";

const api = spawn(process.execPath, ["api.mjs"], { stdio: "inherit" });
const vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite"], { stdio: "inherit" });
const stop = () => { api.kill(); vite.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", stop);
