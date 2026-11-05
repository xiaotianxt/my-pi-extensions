const auth = await Bun.file(`${Bun.env.HOME ?? Bun.env.USERPROFILE}/.pi/agent/auth.json`).json();
const creds = auth.antigravity;
const oauth = await import(new URL("../src/auth/oauth.ts", import.meta.url).href);
const usageMod = await import(new URL("../src/usage/usage.ts", import.meta.url).href);

const refreshed = await oauth.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const apiKey = oauth.getApiKey(refreshed);
const usage = await usageMod.fetchAccountUsage(apiKey);
console.log(usageMod.formatUsageSummary(usage));
console.log("\n----\n");
console.log(usageMod.formatModelsList(usage));
