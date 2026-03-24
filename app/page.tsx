import { Scanner } from "@/components/scanner";

export default function Home() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight mb-2">
        Chat Widget Detector
      </h1>
      <p className="text-zinc-400 mb-8">
        Enter a URL to detect chat widgets on the page.
      </p>
      <Scanner />
    </main>
  );
}
