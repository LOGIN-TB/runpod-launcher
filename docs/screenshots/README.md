# Screenshots

Generated, never taken by hand:

```bash
# a throwaway service with invented data
DATA_DIR=./tmp PORT=8080 ALLOW_UI_ORIGIN=http://localhost:5173 node apps/service/dist/index.js
npm run dev -w @runpod-launcher/desktop

TOKEN=$(node tools/screenshots/seed.mjs http://localhost:8080 <pairing-code>)
DEVICE_TOKEN=$TOKEN npm run screenshots
```

Five screens × two languages × light and dark. The seed data is fixed and
invented — these images end up in a public repository, so they must never
carry a real key, a real pod id or a real bill.

Hand-made screenshots are wrong two changes later, and a guide illustrated with
an interface that no longer exists misleads rather than helps. CI runs the same
pipeline on every push so it cannot rot unnoticed.

Images of RunPod's or Coolify's own interfaces cannot be generated this way.
There are deliberately few of them, each carries a date, and every step also
works from the written instructions alone.
