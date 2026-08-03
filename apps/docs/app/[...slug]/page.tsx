import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { docs, docsBySlug } from "../../lib/docs";

export function generateStaticParams() {
  return docs.map((doc) => ({ slug: [doc.slug] }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = docsBySlug.get(slug.join("/"));
  return doc ? { title: doc.title, description: doc.description } : {};
}

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = docsBySlug.get(slug.join("/"));
  if (!doc) notFound();
  return (
    <article className="doc">
      <header className="doc-header">
        <span className="eyebrow">{doc.group}</span>
        <h1>{doc.title}</h1>
        <p>{doc.description}</p>
      </header>
      {doc.sections.map((section) => (
        <section className="doc-section" key={section.heading}>
          <h2>{section.heading}</h2>
          {section.body?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.steps ? <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
          {section.bullets ? <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
          {section.code ? <pre><code>{section.code}</code></pre> : null}
          {section.note ? <aside className="note"><strong>Note</strong><p>{section.note}</p></aside> : null}
        </section>
      ))}
    </article>
  );
}
