import { List, Panel, Row } from "../components/ui";

export default function SettingsPage() {
  return (
    <>
      <Panel title="Workspace configuration">
        <List>
          <Row href="/integrations" title="Integrations" meta="Connect GitHub and review providers." />
          <Row href="/models" title="Models" meta="Choose models, effort, and review fallback behavior." />
          <Row href="/organization" title="Members & Access" meta="Manage the active organization and its access boundary." />
        </List>
      </Panel>
      <Panel title="Help">
        <List>
          <Row
            href={process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.usejina.com"}
            title="Documentation"
            meta="Onboarding, reviews, Context, causal graphs, and .jina configuration."
          />
        </List>
      </Panel>
    </>
  );
}
