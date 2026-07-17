const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "../node_modules/socket.io-client/dist/socket.io.min.js");
const dst = path.join(__dirname, "../renderer/vendor/socket.io.min.js");
if (!fs.existsSync(path.dirname(dst))) fs.mkdirSync(path.dirname(dst), { recursive: true });
if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log("socket.io copié"); }
else { console.log("socket.io-client non trouvé, installation..."); require("child_process").execSync("npm install socket.io-client", { cwd: path.join(__dirname,".."), stdio:"inherit" }); fs.copyFileSync(src, dst); }
