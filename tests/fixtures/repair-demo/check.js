const fs = require("fs");
JSON.parse(fs.readFileSync(__dirname + "/app.config.json", "utf8"));
console.log("VALID");
