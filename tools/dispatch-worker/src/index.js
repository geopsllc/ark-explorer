// Starts the explorer's Deploy workflow on a schedule. A failed dispatch throws, so it shows as an
// error in the Worker's cron event log in the Cloudflare dashboard.
export default {
  async scheduled(event, env) {
    const res = await fetch(
      `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ark-explorer-dispatch",
        },
        body: JSON.stringify({ ref: env.REF }),
      },
    );
    if (res.status !== 204) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
    console.log(`dispatched ${env.WORKFLOW} on ${env.REF} (cron ${event.cron})`);
  },
};
