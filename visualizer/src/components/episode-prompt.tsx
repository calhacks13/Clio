export function EpisodePrompt({ text }: { text?: string }) {
  if (!text?.trim()) return null;

  return (
    <section className="episode-prompt" aria-label="Task instruction">
      <p>{text}</p>
    </section>
  );
}
