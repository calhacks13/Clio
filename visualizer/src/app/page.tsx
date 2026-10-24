"use client";
import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { authHeaders } from "@/utils/auth";
import { DEFAULT_HUMANOID_PATH, HUMANOID_EXAMPLES } from "@/lib/humanoid";
import HfAuthButton from "@/components/hf-auth-button";
import { Spinner, ThemeToggle } from "@/components/ui";
import { ClioBrand } from "@/components/clio-brand";
import Link from "next/link";
import {
  LuSearch,
  LuBox,
  LuExternalLink,
  LuFolderOpen,
  LuChevronRight,
} from "react-icons/lu";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

const EXAMPLE_DATASETS = [...HUMANOID_EXAMPLES, "lerobot/svla_so101_pickplace"];

function HomeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Handle redirects with useEffect instead of direct redirect
  useEffect(() => {
    // Redirect to the first episode of the dataset if REPO_ID is defined
    if (process.env.REPO_ID) {
      const episodeN =
        process.env.EPISODES?.split(/\s+/)
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !isNaN(x))[0] ?? 0;

      router.push(`/${process.env.REPO_ID}/episode_${episodeN}`);
      return;
    }

    // sync with hf.co/spaces URL params
    if (searchParams.get("path")) {
      router.push(searchParams.get("path")!);
      return;
    }

    // legacy sync with hf.co/spaces URL params
    let redirectUrl: string | null = null;
    if (searchParams.get("dataset") && searchParams.get("episode")) {
      redirectUrl = `/${searchParams.get("dataset")}/episode_${searchParams.get("episode")}`;
    } else if (searchParams.get("dataset")) {
      redirectUrl = `/${searchParams.get("dataset")}`;
    }

    if (redirectUrl && searchParams.get("t")) {
      redirectUrl += `?t=${searchParams.get("t")}`;
    }

    if (redirectUrl) {
      router.push(redirectUrl);
      return;
    }
    if (searchParams.get("browse") !== "1")
      router.replace(DEFAULT_HUMANOID_PATH);
  }, [searchParams, router]);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      setIsLoading(false);
      setHasFetched(false);
      return;
    }
    setIsLoading(true);
    setHasFetched(false);
    setShowSuggestions(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://huggingface.co/api/quicksearch?q=${encodeURIComponent(query)}&type=dataset`,
          { cache: "no-store", headers: authHeaders() },
        );
        const data = await res.json();
        const ids: string[] = (
          (data.datasets as { id: string }[] | undefined) ?? []
        ).map((d) => d.id);
        setSuggestions(ids);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      } finally {
        setIsLoading(false);
        setHasFetched(true);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navigate = useCallback(
    (value: string) => {
      setShowSuggestions(false);
      router.push(value);
    },
    [router],
  );

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const target =
      activeIndex >= 0 && suggestions[activeIndex]
        ? suggestions[activeIndex]
        : query.trim();
    if (target) navigate(target);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setActiveIndex(-1);
    }
  };

  if (searchParams.get("browse") !== "1")
    return (
      <main className="min-h-screen bg-bg text-fg flex items-center justify-center">
        <p role="status">Opening replay…</p>
      </main>
    );

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="workspace-header">
        <Link href="/" className="brand-link" aria-label="Clio visualizer home">
          <ClioBrand />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-context">Visualizer</span>
        </Link>
        <div />
        <div className="header-actions">
          <ThemeToggle />
          <HfAuthButton variant="tab" />
        </div>
      </header>
      <main className="browse-page">
        <h1 className="text-[32px] font-semibold leading-tight">
          Open a dataset
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-fg-muted">
          Inspect a public LeRobot recording from Hugging Face.
        </p>
        <form onSubmit={handleSubmit} className="browse-form">
          <div ref={containerRef} className="relative min-w-0 flex-1">
            <LuSearch
              size={18}
              className="pointer-events-none absolute left-4 top-4 text-fg-muted"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => query.trim() && setShowSuggestions(true)}
              placeholder="organization / dataset"
              aria-label="Dataset ID"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls="dataset-suggestions"
              aria-activedescendant={
                activeIndex >= 0
                  ? `dataset-suggestion-${activeIndex}`
                  : undefined
              }
              className="browse-input"
              autoComplete="off"
            />
            {showSuggestions && (
              <ul
                id="dataset-suggestions"
                role="listbox"
                className="absolute left-0 right-0 top-full z-50 mt-2 max-h-64 overflow-y-auto rounded-2xl border border-line bg-surface-1 p-2 shadow-lg"
              >
                {isLoading ? (
                  <li
                    role="presentation"
                    className="flex items-center gap-2 p-3 text-sm text-fg-muted"
                  >
                    <Spinner /> Searching…
                  </li>
                ) : suggestions.length > 0 ? (
                  suggestions.map((id, i) => (
                    <li
                      key={id}
                      id={`dataset-suggestion-${i}`}
                      role="option"
                      aria-selected={i === activeIndex}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-sm break-all ${i === activeIndex ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill"}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          navigate(id);
                        }}
                        onMouseEnter={() => setActiveIndex(i)}
                      >
                        {id}
                      </button>
                    </li>
                  ))
                ) : (
                  hasFetched && (
                    <li
                      role="presentation"
                      className="p-3 text-sm text-fg-muted"
                    >
                      No matching datasets. You can still open an exact dataset
                      ID.
                    </li>
                  )
                )}
              </ul>
            )}
          </div>
          <button
            type="submit"
            disabled={!query.trim()}
            className="btn btn-primary !px-6 !text-sm"
          >
            Open dataset
          </button>
        </form>
        <section className="mt-12" aria-labelledby="clio-heading">
          <h2 id="clio-heading" className="text-base font-semibold">
            Clio recordings
          </h2>
          <div className="mt-3">
            <Link href="/clio" className="dataset-row">
              <span className="flex min-w-0 items-center gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-0">
                  <LuFolderOpen size={20} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Recordings</span>
                  <span className="mt-1 block text-xs text-fg-muted">
                    This computer
                  </span>
                </span>
              </span>
              <LuChevronRight
                size={16}
                className="shrink-0 text-fg-muted"
                aria-hidden="true"
              />
            </Link>
          </div>
        </section>
        <section className="mt-12" aria-labelledby="example-heading">
          <h2 id="example-heading" className="text-base font-semibold">
            Example recordings
          </h2>
          <div className="mt-3">
            {EXAMPLE_DATASETS.map((ds) => (
              <button
                key={ds}
                type="button"
                className="dataset-row"
                onClick={() => navigate(ds)}
              >
                <span className="flex min-w-0 items-center gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-0">
                    <LuBox size={20} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words font-medium">
                      {ds
                        .split("/")[1]
                        .replace(/_Dataset$/i, "")
                        .replace(/_/g, " ")}
                    </span>
                    <span className="mt-1 block text-xs text-fg-muted">
                      {ds.split("/")[0]}
                    </span>
                  </span>
                </span>
                <LuExternalLink
                  size={16}
                  className="shrink-0 text-fg-muted"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>
        <footer className="mt-12 text-xs text-fg-muted">
          Built on the{" "}
          <a
            href="https://github.com/huggingface/lerobot"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-fg"
          >
            LeRobot Dataset Visualizer
          </a>
          .
        </footer>
      </main>
    </div>
  );
}
