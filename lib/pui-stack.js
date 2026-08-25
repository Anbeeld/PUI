#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function readStackValue(file, key) {
  const stack = JSON.parse(fs.readFileSync(file, "utf8"));
  let value = stack;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object" || !(part in value)) {
      throw new Error(`Missing key: ${key}`);
    }
    value = value[part];
  }
  return value;
}

function main(argv) {
  const [file, key] = argv;
  if (!file || !key) {
    console.error("Usage: pui-stack.js <stack.json> <dot.key>");
    return 64;
  }
  try {
    const value = readStackValue(file, key);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
    return 0;
  } catch (error) {
    console.error(`pui-stack: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { readStackValue };
