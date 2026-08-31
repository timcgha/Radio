#!/usr/bin/env node
/**
 * Git credential helper for Radio source verification.
 * Reads RADIO_GITHUB_TOKEN from the environment at runtime — never embeds secrets.
 */
const token = process.env.RADIO_GITHUB_TOKEN?.trim();
if (!token) {
  process.exit(1);
}

const prompt = (process.argv[2] ?? "").toLowerCase();
if (prompt.includes("username")) {
  process.stdout.write("x-access-token");
} else {
  process.stdout.write(token);
}
