# Clio

**Every lesson trains two students: you, and a robot.**

Clio is an AR coach for Meta Quest 3, built with WebXR. It talks you through a hands-on task step by
step, highlights what to touch, and shows the move with "ghost hands". Every session is recorded as
intent-labeled hand and object data that robots can learn from.
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Data formats: [docs/data-format.md](docs/data-format.md)
- Task scripts: [docs/procedures.md](docs/procedures.md)
- Setup (Quest, emulator, server): [docs/dev-setup.md](docs/dev-setup.md)

```bash
pnpm install
cp .env.example .env    # add GEMINI_API_KEY
pnpm dev                # server on :8787, headset app on :5173
```
