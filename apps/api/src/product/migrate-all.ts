import { spawn } from "node:child_process";

await run(process.execPath, ["node_modules/@jina/db/dist/migrate.js", ...process.argv.slice(2)]);
await run(process.execPath, ["dist/product/migrate.js"]);
console.log("unified v2 database migrations complete");

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}
