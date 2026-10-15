# w3bs desktop runner

Works a SubmitFleet campaign's assisted submissions with an agent on a w3bs desktop
(Kubuntu container from `w3bs fleet desktop start`): for each submission it opens Chrome on
the directory's submit page, has Claude Code fill the form through the `w3bs-desktop` MCP using
only the approved copy kit, saves a screenshot as evidence, and marks the result in SubmitFleet.

It stops for a person, and never works around: account sign-up/sign-in, CAPTCHA, payment,
and any field whose fact is not in the kit. Watch it live at w3bs.org/fleet.

## Setup (on the desktop host)

```sh
mkdir -p ~/.config/submitfleet-runner ~/submitfleet-runner
cp run.mjs dx ~/submitfleet-runner/
# 0600 files, never on a command line:
#   ~/.config/submitfleet-runner/anthropic.key    ANTHROPIC_API_KEY for `claude -p`
#   ~/.config/submitfleet-runner/submitfleet.key  an owner API key from submitfleet.com Settings
#   ~/.config/submitfleet-runner/mcp.json         {"mcpServers":{"w3bs-desktop":{"type":"http",
#        "url":"http://127.0.0.1:7801/mcp","headers":{"Authorization":"Bearer <agent token>"}}}}
# Agent token: `w3bs desktop agents add submitfleet` then `agents update --policy broad submitfleet`
#   inside the container (run with ./dx so the session environment is set).
```

## Run

```sh
node ~/submitfleet-runner/run.mjs --campaign cmp_... --limit 25 --budget 25 [--dry-run]
```

State (what was attempted) is kept per campaign in `~/submitfleet-runner/state-<campaign>.json`,
so re-running continues where it stopped; evidence PNGs go to `~/submitfleet-runner/evidence/`.

## First pilot (2026-10-15, hdtilt.com, dev3)

25 directories, $1.70: 0 submitted, 1 correctly skipped (AI-only directory), 24 stopped for a
person: 14 account required, 4 CAPTCHA, 6 asked for facts not in the profile (name, phone,
street address, city, funding). Unlocking more needs owner decisions, not more automation.
