import Link from "next/link";
import { docGroups } from "../lib/docs";

export default function DocsHomePage() {
  return (
    <div className="home">
      <header className="hero">
        <span className="eyebrow">Jina documentation</span>
        <h1>Understand your code. Review every change with evidence.</h1>
        <p>
          Everything you need to connect a repository, run high-confidence reviews, build repository context, and
          configure Jina for your engineering standards.
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/getting-started">
            Get started
          </Link>
          <Link className="secondary-link" href="/jina-configuration">
            Configure .jina
          </Link>
        </div>
      </header>
      <div className="doc-grid">
        {docGroups
          .flatMap(({ docs }) => docs)
          .map((doc) => (
            <Link className="doc-card" href={`/${doc.slug}`} key={doc.slug}>
              <span>{doc.group}</span>
              <h2>{doc.title}</h2>
              <p>{doc.description}</p>
            </Link>
          ))}
      </div>
    </div>
  );
}
