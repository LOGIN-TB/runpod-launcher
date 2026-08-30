# Icons

`icon.svg` is the source. Everything else is generated:

```bash
qlmanage -t -s 1024 -o . icon.svg && sips -Z 1024 -s format png icon.svg.png --out icon-1024.png
npx tauri icon icon-1024.png
```

The Android and iOS sets `tauri icon` also produces are deleted — this is a
desktop-only project and they are 400 KB of dead weight in every clone.
