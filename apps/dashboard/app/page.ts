export function renderDashboardPage(apiUrl: string, apiLabel = apiUrl): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jina board</title>
<style>
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #090b10;
    color: #f4f5f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% -10%, #17213d 0, transparent 32rem), #090b10; }
  button, a { font: inherit; }
  button { color: inherit; }
  .shell { max-width: 1500px; margin: 0 auto; padding: 2rem; }
  .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
  .eyebrow { margin: 0 0 .35rem; color: #8491aa; font-size: .7rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 1.55rem; letter-spacing: -.03em; }
  #connection { display: flex; align-items: center; gap: .5rem; color: #9aa4b7; font-size: .78rem; }
  .pulse { width: .5rem; height: .5rem; border-radius: 50%; background: #3ddc97; box-shadow: 0 0 0 .25rem rgb(61 220 151 / 12%); }
  .pulse.offline { background: #ff6b6b; box-shadow: 0 0 0 .25rem rgb(255 107 107 / 12%); }
  .toolbar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
  .toolbar button, .ghost-button {
    border: 1px solid #293044; border-radius: .55rem; background: #121722; padding: .48rem .72rem; cursor: pointer; font-size: .75rem;
  }
  .toolbar button:hover, .ghost-button:hover { border-color: #56627c; background: #181f2d; }
  .toolbar-label { color: #77839a; font-size: .72rem; margin-right: .15rem; }
  .page-nav { display: flex; gap: .35rem; margin-bottom: 1.25rem; border-bottom: 1px solid #202637; }
  .page-nav a { padding: .65rem .15rem .6rem; margin-right: 1rem; color: #78849a; text-decoration: none; font-size: .76rem; font-weight: 650; border-bottom: 2px solid transparent; }
  .page-nav a:hover { color: #c5ccda; }
  .page-nav a.active { color: #f1f3f7; border-bottom-color: #809cff; }
  .page-note { margin: 0 0 1rem; color: #77839a; font-size: .72rem; }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: .85rem; align-items: start; }
  .column { border: 1px solid #202637; border-radius: .8rem; background: rgb(15 19 28 / 78%); padding: .65rem; min-height: 10rem; }
  .column h2 { display: flex; justify-content: space-between; margin: .15rem .15rem .65rem; color: #8e99ad; font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; }
  .count { display: grid; place-items: center; min-width: 1.25rem; height: 1.25rem; border-radius: 99px; background: #20283a; color: #c6cede; font-size: .65rem; }
  .card {
    width: 100%; border: 1px solid #2a3144; border-radius: .7rem; background: linear-gradient(145deg, #171c27, #121620);
    padding: .75rem; margin-bottom: .55rem; text-align: left; cursor: pointer; transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .card:hover { transform: translateY(-1px); border-color: #5b6a88; background: #1a2030; }
  .card:focus-visible { outline: 2px solid #8ea8ff; outline-offset: 2px; }
  .card-title { display: block; font-size: .82rem; font-weight: 650; line-height: 1.35; }
  .card-meta { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .6rem; color: #838ea2; font-size: .66rem; }
  .chip { border: 1px solid #2d3548; border-radius: 99px; padding: .12rem .38rem; }
  .task-panel { border: 1px solid #202637; border-radius: .85rem; background: rgb(15 19 28 / 78%); overflow: hidden; }
  .task-panel-header { display: flex; align-items: center; justify-content: space-between; padding: .85rem 1rem; border-bottom: 1px solid #22293a; }
  .task-panel-header h2 { margin: 0; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; color: #a5afc1; }
  .task-count { color: #748198; font-size: .7rem; }
  .workflow-panel { margin-bottom: 1rem; border: 1px solid #202637; border-radius: .85rem; background: rgb(15 19 28 / 78%); overflow: hidden; }
  .workflow-help { margin: 0; padding: .75rem 1rem 0; color: #7c899f; font-size: .7rem; line-height: 1.5; }
  .workflow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: .8rem; padding: 1rem; }
  .workflow-tree { min-width: 0; border: 1px solid #293249; border-radius: .8rem; background: linear-gradient(145deg, #141a26, #0f141e); overflow: hidden; }
  .workflow-tree-header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .72rem .8rem; border-bottom: 1px solid #252e42; }
  .workflow-tree-name { color: #dce3ef; font: .77rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 750; }
  .workflow-tree-count { color: #748198; font-size: .62rem; }
  .workflow-tree-body { padding: .8rem; }
  .workflow-tree-root, .workflow-children { margin: 0; padding: 0; list-style: none; }
  .workflow-children { position: relative; display: grid; gap: .15rem; margin-left: 1rem; padding-left: 1.15rem; border-left: 1px solid #33405a; }
  .workflow-branch { position: relative; min-width: 0; }
  .workflow-children > .workflow-branch::before { content: ""; position: absolute; top: 1.12rem; left: -1.15rem; width: .85rem; border-top: 1px solid #33405a; }
  .workflow-connector { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; min-height: 1.1rem; margin: .1rem 0 .25rem; color: #71809a; font-size: .58rem; }
  .workflow-connector strong { color: #8da8f2; font-size: .59rem; letter-spacing: .03em; text-transform: uppercase; }
  .workflow-connector-condition { color: #c69a59; }
  .workflow-trigger { display: flex; align-items: flex-start; flex-wrap: wrap; gap: .35rem; margin: 0 0 .38rem; border: 1px solid #3d4c6b; border-radius: .58rem; background: #111a29; padding: .5rem .58rem; color: #9ba9c0; font-size: .61rem; line-height: 1.4; }
  .workflow-trigger strong { color: #a9c1ff; font-size: .58rem; letter-spacing: .08em; text-transform: uppercase; }
  .workflow-trigger-source { color: #d9e2f2; font: .62rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
  .workflow-trigger-description { flex-basis: 100%; color: #78879f; }
  .workflow-node { border: 1px solid #303a50; border-radius: .65rem; background: #151b27; padding: .62rem .68rem; }
  .workflow-node.aggregate { border-color: #55658a; background: linear-gradient(145deg, #1a2232, #141a26); }
  .workflow-node-top { display: flex; align-items: center; justify-content: space-between; gap: .55rem; }
  .workflow-node-name { min-width: 0; color: #e0e6f0; font: .7rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 720; overflow-wrap: anywhere; }
  .workflow-node-badge { flex: 0 0 auto; border: 1px solid #35415a; border-radius: 99px; padding: .12rem .35rem; color: #8391a8; font-size: .54rem; white-space: nowrap; }
  .workflow-node-description { display: block; margin-top: .32rem; color: #7f8ca2; font-size: .63rem; line-height: 1.42; }
  .workflow-node-gates { display: block; margin-top: .38rem; color: #9b8db7; font-size: .58rem; line-height: 1.4; }
  .workflow-empty { padding: 1rem; color: #657188; font-size: .7rem; }
  .task-list { display: grid; }
  .type-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 1rem; width: 100%;
    border-bottom: 1px solid #202738; padding: .9rem 1rem;
  }
  .type-row:last-child { border-bottom: 0; }
  .type-copy { min-width: 0; }
  .type-name { display: block; font: .8rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: #dce2ed; }
  .type-description { display: block; margin-top: .35rem; color: #8793a8; font-size: .72rem; line-height: 1.45; }
  .type-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .35rem; color: #8b97ac; font-size: .65rem; }
  .type-chip { border: 1px solid #30394d; border-radius: 99px; padding: .18rem .42rem; white-space: nowrap; }
  .type-dependency-groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .55rem; margin-top: .75rem; }
  .type-dependency-group { min-width: 0; border: 1px solid #252d40; border-radius: .6rem; background: #111620; padding: .55rem .6rem; }
  .type-dependency-label { display: block; margin-bottom: .38rem; color: #6f7d94; font-size: .58rem; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
  .type-dependency-list { display: grid; gap: .38rem; }
  .type-dependency { min-width: 0; }
  .type-dependency-name { display: block; color: #cbd3e1; font: .68rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; }
  .type-dependency-detail { display: block; margin-top: .1rem; color: #76839a; font-size: .6rem; line-height: 1.4; overflow-wrap: anywhere; }
  .type-dependency-empty { color: #59667c; font-size: .63rem; }
  .superseded { opacity: .48; }
  .empty { padding: 1.5rem .5rem; color: #586277; text-align: center; font-size: .72rem; }
  .feed { margin-top: 1.4rem; border-top: 1px solid #1f2534; padding-top: 1rem; }
  .feed h2 { margin: 0 0 .6rem; font-size: .78rem; color: #8f9aaf; }
  #log { color: #68748a; font: .68rem/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
  .ontology-shell { display: grid; gap: 1rem; }
  .ontology-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .65rem; }
  .ontology-stat { border: 1px solid #283149; border-radius: .8rem; background: linear-gradient(145deg, #151b29, #10151f); padding: .8rem; }
  .ontology-stat strong { display: block; margin-top: .35rem; font-size: 1.05rem; }
  .ontology-card { border: 1px solid #252d40; border-radius: .9rem; background: rgb(14 18 27 / 84%); overflow: hidden; }
  .ontology-card header { display: flex; justify-content: space-between; gap: 1rem; padding: .9rem 1rem; border-bottom: 1px solid #252d40; }
  .ontology-card h2 { margin: 0; font-size: .82rem; }
  .ontology-card p { margin: .3rem 0 0; color: #7f8ba1; font-size: .72rem; line-height: 1.45; }
  .graph-controls { display: grid; gap: .65rem; padding: .75rem 1rem; border-bottom: 1px solid #252d40; background: #10151f; }
  .graph-filter-row { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr) auto; align-items: start; gap: .65rem; }
  .graph-filter-label { padding-top: .3rem; color: #7f8ca2; font-size: .62rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .graph-filter-list { display: flex; flex-wrap: wrap; gap: .38rem; }
  .graph-filter-chip, .graph-reset {
    border: 1px solid #3c4962; border-radius: 99px; background: #1a2231; padding: .28rem .52rem; color: #d1d8e5; cursor: pointer; font-size: .62rem;
  }
  .graph-filter-chip::before { content: ""; display: inline-block; width: .42rem; height: .42rem; margin-right: .35rem; border-radius: 50%; background: #78a0ff; vertical-align: .03rem; }
  .graph-filter-chip[data-filter-group="edge"]::before { background: #d88fff; }
  .graph-filter-chip[aria-pressed="false"] { border-color: #293143; background: #111620; color: #68758b; text-decoration: line-through; }
  .graph-filter-chip[aria-pressed="false"]::before { background: #465166; }
  .graph-filter-chip:hover, .graph-reset:hover { border-color: #7184aa; background: #202b40; }
  .graph-filter-chip:focus-visible, .graph-reset:focus-visible, .graph-node:focus-visible, .graph-edge-group:focus-visible { outline: 2px solid #9bb2ff; outline-offset: 2px; }
  .graph-reset { align-self: start; border-radius: .5rem; background: #151c29; }
  .graph-reset:disabled { opacity: .42; cursor: default; }
  .graph-wrap { min-height: 590px; overflow: auto; background: radial-gradient(circle at 50% 50%, #182036, #0d1119 66%); }
  #ontology-graph { display: block; width: 100%; min-width: 900px; height: 590px; }
  .graph-edge { stroke-width: 1.5; opacity: .62; }
  .graph-edge-hit { stroke: transparent; stroke-width: 16; cursor: pointer; }
  .graph-edge-group { cursor: pointer; }
  .graph-edge-group:hover .graph-edge, .graph-edge-group.selected .graph-edge { stroke-width: 3.5; opacity: 1; }
  .graph-edge-group:hover .graph-edge-label, .graph-edge-group.selected .graph-edge-label { fill: #f2f5fa; font-weight: 750; }
  .graph-edge-code { stroke: #6495ed; }
  .graph-edge-knowledge { stroke: #d88fff; stroke-dasharray: 5 4; }
  .graph-edge-label { fill: #7e8ca5; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-anchor: middle; pointer-events: none; }
  .graph-node { cursor: pointer; }
  .graph-node circle { stroke-width: 2; filter: drop-shadow(0 5px 8px rgb(0 0 0 / 35%)); transition: stroke-width 120ms ease, filter 120ms ease; }
  .graph-node:hover circle, .graph-node.selected circle { stroke-width: 4; filter: drop-shadow(0 0 10px rgb(142 168 255 / 65%)); }
  .graph-node text { fill: #e8ecf4; font-size: 11px; font-weight: 650; text-anchor: middle; pointer-events: none; }
  .graph-node .node-kind { fill: #8794aa; font-size: 9px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; }
  .kind-Repository circle { fill: #263d78; stroke: #8ba9ff; }
  .kind-File circle { fill: #163f3b; stroke: #59d7bf; }
  .kind-Symbol circle { fill: #45321c; stroke: #efb964; }
  .kind-Document circle { fill: #3f244e; stroke: #cf89e9; }
  .kind-Feature circle { fill: #173b50; stroke: #5fd3f3; }
  .kind-Commit circle, .kind-PullRequest circle, .kind-Issue circle { fill: #3c2830; stroke: #ef879f; }
  .kind-Engineer circle, .kind-Team circle { fill: #283248; stroke: #91a7d4; }
  .ontology-details { display: grid; gap: .7rem; padding: 1rem; border-top: 1px solid #252d40; }
  .ontology-item { border: 1px solid #262e42; border-radius: .7rem; background: #121722; padding: .72rem; }
  .ontology-item strong { display: block; font-size: .74rem; }
  .ontology-item span { display: block; margin-top: .3rem; color: #7e8aa0; font-size: .66rem; line-height: 1.45; }
  .ontology-item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .7rem; }
  .ontology-item-type { flex: 0 0 auto; border: 1px solid #36415a; border-radius: 99px; padding: .15rem .4rem; color: #8da1c4; font-size: .58rem; }
  .ontology-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .55rem; margin-top: .7rem; }
  .ontology-detail-field { border: 1px solid #242d40; border-radius: .55rem; background: #0f141e; padding: .55rem .6rem; }
  .ontology-detail-field .label { margin-bottom: .25rem; }
  .ontology-detail-field .value { color: #d3dae6; font-size: .68rem; line-height: 1.45; }
  .graph-empty { fill: #6f7d94; font-size: 14px; text-anchor: middle; }
  .plane-key { display: flex; gap: .8rem; align-items: center; color: #7f8ca2; font-size: .66rem; }
  .plane-key span::before { content: ""; display: inline-block; width: 1.4rem; margin-right: .35rem; border-top: 2px solid #6495ed; vertical-align: middle; }
  .plane-key .knowledge::before { border-top-color: #d88fff; border-top-style: dashed; }
  .context-query { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .55rem; padding: .85rem; border: 1px solid #252d40; border-radius: .85rem; background: #10151f; }
  .context-query input { min-width: 0; border: 1px solid #303a50; border-radius: .55rem; background: #0d1119; color: #eef1f6; padding: .65rem .75rem; }
  .context-query button { border: 1px solid #52668f; border-radius: .55rem; background: #283a68; padding: .6rem .9rem; cursor: pointer; }
  .context-results { display: grid; gap: .55rem; }
  .context-answer { border: 1px solid #465d88; border-radius: .75rem; background: linear-gradient(135deg, #121d30, #101722 72%); padding: .85rem; }
  .context-answer-label { display: block; margin-bottom: .4rem; color: #a9c1ff; font-size: .6rem; font-weight: 780; letter-spacing: .1em; text-transform: uppercase; }
  .context-answer-text { margin: 0; color: #e2e7f0; font-size: .76rem; line-height: 1.55; }
  .context-claims { display: grid; gap: .38rem; margin-top: .7rem; }
  .context-claims h4 { margin: 0; color: #8997af; font-size: .59rem; letter-spacing: .08em; text-transform: uppercase; }
  .context-claim { border-left: 2px solid #526fa5; padding-left: .55rem; }
  .context-claim strong { display: block; color: #cad3e3; font-size: .68rem; line-height: 1.42; }
  .context-citations { display: block; margin-top: .18rem; color: #7f8ca2; font: .59rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .context-notices { display: grid; gap: .35rem; }
  .context-notice { border: 1px solid #554629; border-radius: .58rem; background: #1b1812; padding: .55rem .62rem; color: #c4ad82; font-size: .65rem; line-height: 1.45; }
  .context-notice strong { margin-right: .25rem; color: #e2c58f; text-transform: uppercase; letter-spacing: .05em; font-size: .57rem; }
  .context-call { border: 1px solid #283149; border-radius: .7rem; background: #111722; padding: .75rem; }
  .context-call h3 { margin: 0 0 .5rem; color: #aeb9cd; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  .context-result { padding: .45rem 0; border-top: 1px solid #252d40; }
  .context-result strong { display: block; font-size: .74rem; }
  .context-result span { display: block; margin-top: .25rem; color: #7f8ca2; font: .64rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .issue-trace { display: grid; gap: .6rem; padding: .7rem 0 .2rem; }
  .trace-chain { display: flex; flex-wrap: wrap; align-items: center; gap: .42rem; padding: .58rem .65rem; border: 1px solid #2d3851; border-radius: .58rem; background: #0e141e; }
  .trace-chain.trace-cause { border-color: #4a628d; background: linear-gradient(135deg, #111b2b, #0e141e 68%); }
  .trace-chain a { color: #91afff; font-size: .72rem; font-weight: 650; text-decoration: none; }
  .trace-chain a:hover { text-decoration: underline; }
  .trace-answer-label { flex-basis: 100%; color: #8290aa; font-size: .58rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .trace-answer-label-cause { color: #a9c1ff; }
  .trace-arrow { color: #697993; font-size: .7rem; }
  .trace-changes { flex-basis: 100%; color: #7f8ca2; font: .62rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .trace-explanation { flex-basis: 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .55rem; margin-top: .18rem; }
  .trace-fact { min-width: 0; border: 1px solid #29364e; border-radius: .5rem; background: #101724; padding: .58rem .62rem; }
  .trace-fact-label { display: block; margin-bottom: .28rem; color: #afc4fb; font-size: .6rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .trace-fact-value { margin: 0; color: #d5dbe7; font-size: .68rem; line-height: 1.48; overflow-wrap: anywhere; }
  .trace-evidence-list { display: flex; flex-wrap: wrap; gap: .3rem; }
  .trace-evidence { border: 1px solid #34425c; border-radius: .35rem; background: #151e2d; padding: .2rem .35rem; color: #aebbd1; font: .6rem/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .trace-empty { color: #8b98ad; font-size: .7rem; }

  dialog { width: min(760px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); padding: 0; border: 1px solid #30394e; border-radius: 1rem; background: #10141d; color: #f3f5f8; box-shadow: 0 2rem 6rem rgb(0 0 0 / 55%); }
  dialog::backdrop { background: rgb(3 5 9 / 72%); backdrop-filter: blur(5px); }
  .detail-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1.2rem 1.35rem; border-bottom: 1px solid #262d3e; background: rgb(16 20 29 / 94%); backdrop-filter: blur(12px); }
  .detail-title { margin: .15rem 0 0; font-size: 1.15rem; line-height: 1.3; letter-spacing: -.02em; }
  .close { display: grid; place-items: center; width: 2rem; height: 2rem; border: 1px solid #30384b; border-radius: .5rem; background: #171c27; cursor: pointer; font-size: 1rem; }
  .detail-body { padding: 1.25rem 1.35rem 1.6rem; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: .55rem; margin-bottom: 1.25rem; }
  .summary-item { border: 1px solid #242c3e; border-radius: .65rem; background: #141923; padding: .62rem .7rem; }
  .label { display: block; margin-bottom: .25rem; color: #727f96; font-size: .62rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .value { display: block; font-size: .76rem; overflow-wrap: anywhere; }
  .status { display: inline-flex; align-items: center; gap: .35rem; font-weight: 700; }
  .status::before { content: ""; width: .42rem; height: .42rem; border-radius: 50%; background: #76839c; }
  .status-done::before { background: #3ddc97; }
  .status-in_progress::before, .status-queued::before { background: #71a7ff; }
  .status-failed::before, .status-canceled::before { background: #ff6b6b; }
  .status-blocked::before, .status-triage::before { background: #f4bd50; }
  .section { margin-top: 1.25rem; }
  .section h3 { margin: 0 0 .65rem; color: #aab3c4; font-size: .72rem; letter-spacing: .07em; text-transform: uppercase; }
  .relationship-list { display: grid; gap: .45rem; }
  .relationship {
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .65rem; width: 100%; border: 1px solid #272f42; border-radius: .65rem; background: #141923; padding: .62rem .7rem; text-align: left; cursor: pointer;
  }
  .relationship:hover { border-color: #596783; }
  .relation-direction { color: #71809a; font-size: .66rem; }
  .relation-title { font-size: .76rem; font-weight: 620; }
  .relation-type { color: #8290aa; font: .62rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .metadata { margin: 0; display: grid; grid-template-columns: minmax(110px, .35fr) minmax(0, 1fr); border: 1px solid #272f42; border-radius: .65rem; overflow: hidden; }
  .metadata dt, .metadata dd { margin: 0; padding: .52rem .65rem; border-bottom: 1px solid #232a3a; font-size: .7rem; overflow-wrap: anywhere; }
  .metadata dt { color: #77849a; background: #141923; }
  .metadata dd { color: #d6dbe5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .metadata dt:last-of-type, .metadata dd:last-of-type { border-bottom: 0; }
  .metadata a { color: #8eabff; }
  .timeline { position: relative; display: grid; gap: .55rem; }
  .event { border-left: 2px solid #303a50; padding: .2rem 0 .45rem .8rem; }
  .event-top { display: flex; justify-content: space-between; gap: 1rem; }
  .event-type { font-size: .73rem; font-weight: 650; }
  .event-time { color: #68758c; font-size: .62rem; white-space: nowrap; }
  .event-payload { margin: .35rem 0 0; color: #7e8aa0; font: .64rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty-detail { color: #68758c; font-size: .72rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 640px) { .shell { padding: 1rem; } .topbar { flex-direction: column; } .workflow-grid, .type-row, .type-dependency-groups, .graph-filter-row { grid-template-columns: 1fr; } .workflow-grid { padding: .7rem; } .type-meta { justify-content: flex-start; } .graph-filter-label { padding-top: 0; } .graph-reset { justify-self: start; } .detail-body, .detail-header { padding-left: 1rem; padding-right: 1rem; } }
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div><p class="eyebrow">Review operations</p><h1 id="page-title">Jina board</h1></div>
    <div id="connection"><span class="pulse" id="connection-dot"></span><span id="connection-text">Connecting…</span></div>
  </header>
  <nav class="page-nav" aria-label="Dashboard pages">
    <a href="/" data-page="board">Board</a>
    <a href="/history" data-page="history">History</a>
    <a href="/tasks" data-page="task-types">Task types</a>
    <a href="/ontology" data-page="ontology">Ontology</a>
  </nav>
  <section id="board-page">
    <p class="page-note" id="history-note" hidden>Completed older workflow attempts are retained here for audit and debugging.</p>
    <div class="toolbar" id="toolbar">
      <span class="toolbar-label">Demo events</span>
      <button type="button" data-demo="pr">Open PR</button>
      <button type="button" data-demo="issue">Open issue</button>
      <button type="button" data-demo="push">Force-push PR #42</button>
    </div>
    <section class="columns" id="columns" aria-label="Task board"></section>
    <section class="feed" id="activity-feed"><h2>Recent board activity</h2><div id="log"></div></section>
  </section>
  <section id="task-types-page" hidden>
    <section class="workflow-panel" aria-labelledby="workflow-trees-heading">
      <header class="task-panel-header"><h2 id="workflow-trees-heading">Workflow dependency trees</h2><span class="task-count" id="workflow-count"></span></header>
      <p class="workflow-help">Read top to bottom: completing a prerequisite unblocks the waiting task below it; task creation triggers are shown separately. Conditional connectors apply only when their condition is true, and aggregate tasks close after all required work completes.</p>
      <div class="workflow-grid" id="workflow-tree-list" aria-label="Task dependency trees"></div>
    </section>
    <section class="task-panel" aria-labelledby="task-types-heading">
      <header class="task-panel-header"><h2 id="task-types-heading">Task type registry</h2><span class="task-count" id="task-type-count"></span></header>
      <div class="task-list" id="task-type-list" aria-label="Task type list"></div>
    </section>
  </section>
  <section id="ontology-page" hidden>
    <div class="ontology-shell">
      <section class="ontology-summary" id="ontology-summary"></section>
      <form class="context-query" id="context-query">
        <label class="sr-only" for="context-question">Ask repository context</label>
        <input id="context-question" name="question" placeholder='Ask by issue # or title, e.g. what caused "Administrators cannot delete resources"?' required>
        <button type="submit">Ask with citations</button>
      </form>
      <section class="context-results" id="context-results" aria-live="polite"></section>
      <section class="ontology-card">
        <header>
          <div><h2 id="ontology-title">Repository graph</h2><p id="ontology-description">Waiting for an Ontology worker result.</p></div>
          <div class="plane-key"><span>Code plane</span><span class="knowledge">Knowledge plane</span></div>
        </header>
        <div class="graph-controls" id="graph-controls" aria-label="Graph visibility controls"></div>
        <div class="graph-wrap"><svg id="ontology-graph" viewBox="0 0 1100 590" role="img" aria-label="Repository ontology graph"></svg></div>
        <div class="ontology-details" id="ontology-details" aria-live="polite"></div>
      </section>
    </div>
  </section>
</main>

<dialog id="task-dialog" aria-labelledby="detail-title">
  <header class="detail-header">
    <div><p class="eyebrow" id="detail-eyebrow">Task details</p><h2 class="detail-title" id="detail-title"></h2></div>
    <button type="button" class="close" id="close-detail" aria-label="Close task details">×</button>
  </header>
  <div class="detail-body" id="detail-body"></div>
</dialog>

<script>
const API = ${JSON.stringify(apiUrl)};
const API_LABEL = ${JSON.stringify(apiLabel)};
let boardState = { tasks: [], dependencies: [], publications: [] };
let boardEvents = [];
let taskTypes = [];
let ontologyState = { latest: null, graphs: [] };
let ontologyViewState = { selected: null, hiddenNodeKinds: new Set(), hiddenEdgePredicates: new Set() };
let contextState = null;
let nextPr = 100;
let nextIssue = 200;

const columns = document.getElementById("columns");
const taskTypeList = document.getElementById("task-type-list");
const workflowTreeList = document.getElementById("workflow-tree-list");
const log = document.getElementById("log");
const dialog = document.getElementById("task-dialog");
const detailTitle = document.getElementById("detail-title");
const detailEyebrow = document.getElementById("detail-eyebrow");
const detailBody = document.getElementById("detail-body");
const ontologyGraph = document.getElementById("ontology-graph");
const ontologySummary = document.getElementById("ontology-summary");
const ontologyDetails = document.getElementById("ontology-details");
const graphControls = document.getElementById("graph-controls");
const contextResults = document.getElementById("context-results");

async function refresh() {
  try {
    const showingTaskTypes = location.pathname === "/tasks";
    const showingOntology = location.pathname === "/ontology";
    const showingHistory = location.pathname === "/history";
    if (showingOntology) {
      const response = await fetch(API + "/ontology");
      if (!response.ok) throw new Error("API request failed");
      ontologyState = await response.json();
    } else if (showingTaskTypes) {
      const response = await fetch(API + "/task-types");
      if (!response.ok) throw new Error("API request failed");
      taskTypes = await response.json();
    } else {
      const responses = await Promise.all([fetch(API + "/board"), fetch(API + "/events")]);
      if (!responses[0].ok || !responses[1].ok) throw new Error("API request failed");
      boardState = await responses[0].json();
      boardEvents = await responses[1].json();
    }
    setConnection(true);
    renderPage();
    if (showingOntology) renderOntology();
    else if (showingTaskTypes) renderTaskTypes();
    else {
      const partition = partitionBoardTasks(boardState.tasks);
      renderColumns(showingHistory ? partition.history : partition.current);
      if (!showingHistory) renderLog(partition.current);
      renderSelectedTask();
    }
  } catch (error) {
    setConnection(false);
  }
}

function setConnection(online) {
  document.getElementById("connection-dot").classList.toggle("offline", !online);
  document.getElementById("connection-text").textContent = online ? "Live · " + API_LABEL : "Cannot reach " + API_LABEL;
}

function renderPage() {
  const showingTaskTypes = location.pathname === "/tasks";
  const showingOntology = location.pathname === "/ontology";
  const showingHistory = location.pathname === "/history";
  document.getElementById("board-page").hidden = showingTaskTypes || showingOntology;
  document.getElementById("task-types-page").hidden = !showingTaskTypes;
  document.getElementById("ontology-page").hidden = !showingOntology;
  document.getElementById("toolbar").hidden = showingHistory;
  document.getElementById("activity-feed").hidden = showingHistory;
  document.getElementById("history-note").hidden = !showingHistory;
  document.getElementById("page-title").textContent = showingOntology ? "Ontology" : showingTaskTypes ? "Task types" : showingHistory ? "Task history" : "Jina board";
  for (const link of document.querySelectorAll("[data-page]")) {
    link.classList.toggle("active", link.dataset.page === (showingOntology ? "ontology" : showingTaskTypes ? "task-types" : showingHistory ? "history" : "board"));
  }
}

function renderOntology() {
  ontologyGraph.replaceChildren();
  ontologySummary.replaceChildren();
  ontologyDetails.replaceChildren();
  graphControls.replaceChildren();
  renderContextResults();
  const graph = ontologyState.latest;
  if (!graph) {
    ontologySummary.append(ontologyStat("Status", "No graph yet"));
    ontologyDetails.append(textElement("p", "empty-detail", "Run an ontology_build task to create the first graph."));
    return;
  }

  document.getElementById("ontology-title").textContent = graph.repository + " @ " + graph.ref;
  document.getElementById("ontology-description").textContent = graph.summary;
  const visibleGraph = filterOntologyGraph(graph, ontologyViewState.hiddenNodeKinds, ontologyViewState.hiddenEdgePredicates);
  if (!selectionIsVisible(ontologyViewState.selected, visibleGraph)) ontologyViewState.selected = null;
  ontologySummary.append(
    ontologyStat("Repository", graph.repository),
    ontologyStat("Nodes", visibleCount(visibleGraph.nodes.length, graph.nodes.length)),
    ontologyStat("Edges", visibleCount(visibleGraph.edges.length, graph.edges.length)),
    ontologyStat("Commit", graph.commitSha.slice(0, 12)),
    ontologyStat("Generated", formatTime(graph.generatedAt)),
    ontologyStat("Executor", graph.generator.executor + " · " + graph.generator.model)
  );
  renderGraphControls(graph);

  const positions = graphPositions(visibleGraph.nodes);
  for (const edge of visibleGraph.edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    const selected = ontologyViewState.selected?.kind === "edge" && ontologyViewState.selected.id === edge.id;
    const group = svgElement("g", "graph-edge-group" + (selected ? " selected" : ""));
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", edge.predicate + " edge");
    const hit = svgElement("line", "graph-edge-hit");
    hit.setAttribute("x1", source.x); hit.setAttribute("y1", source.y);
    hit.setAttribute("x2", target.x); hit.setAttribute("y2", target.y);
    const line = svgElement("line", "graph-edge graph-edge-" + edge.plane);
    line.setAttribute("x1", source.x); line.setAttribute("y1", source.y);
    line.setAttribute("x2", target.x); line.setAttribute("y2", target.y);
    const label = svgElement("text", "graph-edge-label");
    label.setAttribute("x", String((source.x + target.x) / 2));
    label.setAttribute("y", String((source.y + target.y) / 2 - 5));
    label.textContent = edge.predicate;
    const title = svgElement("title");
    title.textContent = edge.predicate + " — " + edge.source + " to " + edge.target;
    group.append(hit, line, label, title);
    makeGraphItemInteractive(group, "edge", edge.id);
    ontologyGraph.append(group);
  }
  for (const node of visibleGraph.nodes) {
    const point = positions.get(node.id);
    if (!point) continue;
    const selected = ontologyViewState.selected?.kind === "node" && ontologyViewState.selected.id === node.id;
    const group = svgElement("g", "graph-node kind-" + node.kind + (selected ? " selected" : ""));
    group.setAttribute("transform", "translate(" + point.x + " " + point.y + ")");
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", node.kind + " node: " + node.label);
    const circle = svgElement("circle"); circle.setAttribute("r", node.kind === "Repository" ? "38" : "30");
    const label = svgElement("text"); label.setAttribute("y", "3"); label.textContent = truncateLabel(node.label, 18);
    const kind = svgElement("text", "node-kind"); kind.setAttribute("y", "48"); kind.textContent = node.kind;
    const title = svgElement("title"); title.textContent = node.label + " — " + node.description;
    group.append(circle, label, kind, title);
    makeGraphItemInteractive(group, "node", node.id);
    ontologyGraph.append(group);
  }
  if (!visibleGraph.nodes.length) {
    const empty = svgElement("text", "graph-empty");
    empty.setAttribute("x", "550"); empty.setAttribute("y", "295");
    empty.textContent = "All node types are hidden. Use the controls above to show them.";
    ontologyGraph.append(empty);
  }
  renderOntologyInspector(graph, visibleGraph);
}

function filterOntologyGraph(graph, hiddenNodeKinds, hiddenEdgePredicates) {
  const nodes = graph.nodes.filter(function(node) { return !hiddenNodeKinds.has(node.kind); });
  const visibleNodeIds = new Set(nodes.map(function(node) { return node.id; }));
  const edges = graph.edges.filter(function(edge) {
    return !hiddenEdgePredicates.has(edge.predicate) && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target);
  });
  return { nodes: nodes, edges: edges };
}

function selectionIsVisible(selection, graph) {
  if (!selection) return true;
  const items = selection.kind === "node" ? graph.nodes : graph.edges;
  return items.some(function(item) { return item.id === selection.id; });
}

function visibleCount(visible, total) {
  return visible === total ? String(total) : visible + " / " + total;
}

function renderGraphControls(graph) {
  const nodeKinds = countGraphTypes(graph.nodes, "kind");
  const edgePredicates = countGraphTypes(graph.edges, "predicate");
  graphControls.append(
    graphFilterRow("Node types", "node", nodeKinds, ontologyViewState.hiddenNodeKinds),
    graphFilterRow("Edge types", "edge", edgePredicates, ontologyViewState.hiddenEdgePredicates)
  );
  const reset = textElement("button", "graph-reset", "Show all");
  reset.type = "button";
  reset.disabled = ontologyViewState.hiddenNodeKinds.size === 0 && ontologyViewState.hiddenEdgePredicates.size === 0;
  reset.addEventListener("click", function() {
    ontologyViewState.hiddenNodeKinds.clear();
    ontologyViewState.hiddenEdgePredicates.clear();
    renderOntology();
  });
  graphControls.lastElementChild.append(reset);
}

function countGraphTypes(items, property) {
  const counts = new Map();
  for (const item of items) counts.set(item[property], (counts.get(item[property]) || 0) + 1);
  return Array.from(counts.entries()).sort(function(left, right) { return left[0].localeCompare(right[0]); });
}

function graphFilterRow(label, group, types, hiddenTypes) {
  const row = element("div", "graph-filter-row");
  const list = element("div", "graph-filter-list");
  for (const entry of types) {
    const button = textElement("button", "graph-filter-chip", entry[0] + " · " + entry[1]);
    button.type = "button";
    button.dataset.filterGroup = group;
    button.dataset.filterType = entry[0];
    button.setAttribute("aria-pressed", String(!hiddenTypes.has(entry[0])));
    button.setAttribute("aria-label", (hiddenTypes.has(entry[0]) ? "Show " : "Hide ") + entry[0] + " " + group + " type");
    list.append(button);
  }
  row.append(textElement("span", "graph-filter-label", label), list);
  return row;
}

function toggleGraphFilter(group, type) {
  const hiddenTypes = group === "node" ? ontologyViewState.hiddenNodeKinds : ontologyViewState.hiddenEdgePredicates;
  if (hiddenTypes.has(type)) hiddenTypes.delete(type);
  else hiddenTypes.add(type);
  renderOntology();
}

function makeGraphItemInteractive(element, kind, id) {
  function select(event) {
    event.stopPropagation();
    ontologyViewState.selected = { kind: kind, id: id };
    renderOntology();
  }
  element.addEventListener("click", select);
  element.addEventListener("keydown", function(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(event);
    }
  });
}

function renderOntologyInspector(graph, visibleGraph) {
  const selection = ontologyViewState.selected;
  if (!selection) {
    const message = visibleGraph.nodes.length
      ? "Select a node or relationship in the graph to inspect its metadata and evidence."
      : "No graph items are visible. Turn on a node type above to continue exploring.";
    ontologyDetails.append(textElement("p", "empty-detail", message));
    return;
  }
  if (selection.kind === "node") {
    const node = graph.nodes.find(function(item) { return item.id === selection.id; });
    if (!node) return;
    const relatedEdges = visibleGraph.edges.filter(function(edge) { return edge.source === node.id || edge.target === node.id; });
    const item = ontologyInspectorItem(node.label, "Node · " + node.kind);
    item.append(textElement("span", "", node.description));
    item.append(ontologyDetailGrid([
      ["ID", node.id],
      ["Path", node.path || "Not applicable"],
      ["Visible relationships", String(relatedEdges.length)],
      ["Evidence", evidenceLabel(node.evidence)]
    ]));
    ontologyDetails.append(item);
    return;
  }
  const edge = graph.edges.find(function(item) { return item.id === selection.id; });
  if (!edge) return;
  const source = graph.nodes.find(function(node) { return node.id === edge.source; });
  const target = graph.nodes.find(function(node) { return node.id === edge.target; });
  const item = ontologyInspectorItem(edge.predicate, "Edge · " + edge.plane + " plane");
  item.append(textElement("span", "", (source?.label || edge.source) + " → " + (target?.label || edge.target)));
  item.append(ontologyDetailGrid([
    ["Source", source ? source.kind + " · " + source.label : edge.source],
    ["Target", target ? target.kind + " · " + target.label : edge.target],
    ["Confidence", edge.confidence === undefined ? "Not provided" : Math.round(edge.confidence * 100) + "%"],
    ["Why", edge.why || "No rationale provided"],
    ["Evidence", evidenceLabel(edge.evidence)]
  ]));
  ontologyDetails.append(item);
}

function ontologyInspectorItem(title, type) {
  const item = element("article", "ontology-item");
  const heading = element("div", "ontology-item-heading");
  heading.append(textElement("strong", "", title), textElement("span", "ontology-item-type", type));
  item.append(heading);
  return item;
}

function ontologyDetailGrid(fields) {
  const grid = element("div", "ontology-detail-grid");
  for (const field of fields) {
    const item = element("div", "ontology-detail-field");
    item.append(textElement("span", "label", field[0]), textElement("span", "value", field[1]));
    grid.append(item);
  }
  return grid;
}

function evidenceLabel(evidence) {
  return evidence.length ? evidence.join(", ") : "None provided";
}

function renderContextResults() {
  contextResults.replaceChildren();
  if (!contextState) return;
  if (contextState.error) {
    contextResults.append(textElement("p", "empty-detail", contextState.error));
    return;
  }
  if (contextState.answer) contextResults.append(renderContextAnswer(contextState));
  const notices = renderContextNotices(contextState);
  if (notices) contextResults.append(notices);
  for (const call of contextState.calls || []) {
    const section = element("article", "context-call");
    section.append(textElement("h3", "", call.template + (call.truncated ? " · truncated" : "")));
    if (!call.items.length) section.append(textElement(
      "p",
      "empty-detail",
      call.template === "issue_trace"
        ? "No matching ingested issue or cited relationship was found for the validated issue description or identifier."
        : "No cited results."
    ));
    for (const item of call.items) {
      if (item.kind === "issue_trace" && item.data && item.data.issue) {
        section.append(renderIssueTrace(item.data, item.citations, contextState.question));
        continue;
      }
      const row = element("div", "context-result");
      row.append(textElement("strong", "", item.title));
      if (item.data && item.data.excerpt) row.append(textElement("span", "", item.data.excerpt));
      row.append(textElement("span", "", citationLabels(item.citations).join(" · ")));
      section.append(row);
    }
    contextResults.append(section);
  }
}

function renderContextAnswer(state) {
  const answer = element("article", "context-answer");
  answer.append(
    textElement("span", "context-answer-label", "Answer"),
    textElement("p", "context-answer-text", state.answer)
  );
  const claims = Array.isArray(state.citedClaims) ? state.citedClaims : [];
  if (claims.length) {
    const list = element("div", "context-claims");
    list.append(textElement("h4", "", "Cited claims"));
    for (const claim of claims) {
      const row = element("div", "context-claim");
      row.append(
        textElement("strong", "", claim.text),
        textElement("span", "context-citations", citationLabels(claim.citations).join(" · "))
      );
      list.append(row);
    }
    answer.append(list);
  }
  return answer;
}

function renderContextNotices(state) {
  const ambiguities = Array.isArray(state.unresolvedAmbiguities) ? state.unresolvedAmbiguities : [];
  const gaps = Array.isArray(state.coverageGaps) ? state.coverageGaps : [];
  if (!ambiguities.length && !gaps.length) return null;
  const notices = element("div", "context-notices");
  for (const ambiguity of ambiguities) {
    const row = element("div", "context-notice");
    row.append(textElement("strong", "", "Ambiguity"), document.createTextNode(ambiguity));
    notices.append(row);
  }
  for (const gap of gaps) {
    const row = element("div", "context-notice");
    row.append(textElement("strong", "", "Coverage gap · " + gap.capability), document.createTextNode(gap.message));
    notices.append(row);
  }
  return notices;
}

function citationLabels(citations) {
  return (Array.isArray(citations) ? citations : []).map(function(citation) {
    return citation.path ? citation.path + (citation.startLine ? ":" + citation.startLine : "") : citation.kind + ":" + citation.id;
  });
}

function isCausationQuestion(question) {
  return /\\b(caus(?:e|ed|ation|al)|introduc(?:e|ed|ing)|root cause)\\b/i.test(String(question || ""));
}

function issueTraceSections(trace, question) {
  const causeSections = (Array.isArray(trace.introducedBy) ? trace.introducedBy : []).map(function(commit) {
    return { kind: "cause", value: commit };
  });
  const resolutionSections = (Array.isArray(trace.resolutions) ? trace.resolutions : []).map(function(resolution) {
    return { kind: "resolution", value: resolution };
  });
  return isCausationQuestion(question)
    ? causeSections.concat(resolutionSections)
    : resolutionSections.concat(causeSections);
}

function renderIssueTrace(trace, citations, question) {
  const container = element("div", "issue-trace");
  const issue = trace.issue;
  const sections = issueTraceSections(trace, question);
  const causalQuestion = isCausationQuestion(question);
  if (!sections.length) {
    container.append(issueTraceEntity(issue, true));
    container.append(textElement("p", "trace-empty", "No verified pull request or commit relationship has been asserted."));
    appendTraceCitations(container, citations);
    return container;
  }
  for (const section of sections) {
    container.append(section.kind === "cause"
      ? renderCauseTrace(issue, section.value)
      : renderResolutionTrace(issue, section.value, causalQuestion));
  }
  appendTraceCitations(container, citations);
  return container;
}

function issueTraceEntity(issue, includeTitle) {
  const identity = issue.number ? "Issue #" + issue.number : issue.title || issue.displayId || "Derived issue";
  const label = includeTitle && issue.number && issue.title ? identity + " · " + issue.title : identity;
  return issue.url ? externalLink(label, issue.url) : textElement("span", "trace-node", label);
}

function renderCauseTrace(issue, commit) {
  const chain = element("div", "trace-chain trace-cause");
  chain.append(textElement("span", "trace-answer-label trace-answer-label-cause", "Cause"));
  chain.append(issueTraceEntity(issue, false), textElement("span", "trace-arrow", "was caused by"));
  for (const pullRequest of Array.isArray(commit.pullRequests) ? commit.pullRequests : []) {
    chain.append(externalLink("PR #" + pullRequest.number + " · " + pullRequest.title, pullRequest.url), textElement("span", "trace-arrow", "containing"));
  }
  chain.append(externalLink("commit " + commit.sha.slice(0, 12), commit.url));

  const explanation = element("div", "trace-explanation");
  explanation.append(traceFact("Why", commit.why || "No causal explanation was recorded."));
  explanation.append(traceEvidence(Array.isArray(commit.evidence) ? commit.evidence : []));
  chain.append(explanation);
  return chain;
}

function renderResolutionTrace(issue, resolution, followsCause) {
  const chain = element("div", "trace-chain");
  chain.append(textElement("span", "trace-answer-label", followsCause ? "Later fix" : "Resolution"));
  chain.append(issueTraceEntity(issue, false), textElement("span", "trace-arrow", "→"));
  chain.append(externalLink("PR #" + resolution.pullRequestNumber + " · " + resolution.title, resolution.url));
  for (const commit of Array.isArray(resolution.commits) ? resolution.commits : []) {
    chain.append(textElement("span", "trace-arrow", "→"));
    chain.append(externalLink((commit.role === "merge" ? "merge " : "commit ") + commit.sha.slice(0, 12), commit.url));
    const changes = Array.isArray(commit.changes) ? commit.changes : [];
    if (changes.length) {
      chain.append(textElement("div", "trace-changes", changes.length + " changed file" + (changes.length === 1 ? "" : "s") + ": " + changes.map(function(change) { return change.path; }).join(", ")));
    }
  }
  return chain;
}

function traceFact(label, value) {
  const fact = element("div", "trace-fact");
  fact.append(textElement("span", "trace-fact-label", label), textElement("p", "trace-fact-value", value));
  return fact;
}

function traceEvidence(evidence) {
  const fact = element("div", "trace-fact");
  fact.append(textElement("span", "trace-fact-label", "Evidence"));
  if (!evidence.length) {
    fact.append(textElement("p", "trace-fact-value", "No causal evidence was recorded."));
    return fact;
  }
  const list = element("div", "trace-evidence-list");
  for (const citation of evidence) list.append(textElement("span", "trace-evidence", citation));
  fact.append(list);
  return fact;
}

function appendTraceCitations(container, citations) {
  const provenance = Array.isArray(citations) ? citations : [];
  if (provenance.length) {
    container.append(textElement("div", "trace-changes", "Citations: " + provenance.map(function(citation) {
      return citation.path ? citation.path + (citation.startLine ? ":" + citation.startLine : "") : citation.kind + ":" + citation.id;
    }).join(" · ")));
  }
}

function externalLink(label, url) {
  let safeUrl;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com") safeUrl = parsed.href;
  } catch {}
  if (!safeUrl) return textElement("span", "", label);
  const link = textElement("a", "", label);
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function ontologyStat(label, value) {
  const stat = element("article", "ontology-stat");
  stat.append(textElement("span", "label", label), textElement("strong", "", value));
  return stat;
}

function graphPositions(nodes) {
  const positions = new Map();
  const center = nodes.find(function(node) { return node.kind === "Repository"; });
  if (center) positions.set(center.id, { x: 550, y: 295 });
  const rest = nodes.filter(function(node) { return !center || node.id !== center.id; });
  for (let index = 0; index < rest.length; index += 1) {
    const ring = index < 10 ? 205 : 265;
    const ringIndex = index < 10 ? index : index - 10;
    const ringCount = index < 10 ? Math.min(rest.length, 10) : Math.max(rest.length - 10, 1);
    const angle = -Math.PI / 2 + (Math.PI * 2 * ringIndex) / ringCount;
    positions.set(rest[index].id, { x: 550 + Math.cos(angle) * ring * 1.75, y: 295 + Math.sin(angle) * ring });
  }
  return positions;
}

function svgElement(tag, className) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (className) node.setAttribute("class", className);
  return node;
}

function truncateLabel(value, max) { return value.length <= max ? value : value.slice(0, max - 1) + "…"; }

function partitionBoardTasks(tasks) {
  const latestRequestByScope = new Map();
  for (const task of tasks) {
    if (task.type !== "ontology_build") continue;
    const metadata = task.metadata || {};
    if (!metadata.repository || !metadata.ref || !metadata.requestKey) continue;
    const scope = String(metadata.tenantId || "") + ":" + metadata.repository + ":" + metadata.ref;
    const existing = latestRequestByScope.get(scope);
    if (!existing || String(task.createdAt) > existing.createdAt || (String(task.createdAt) === existing.createdAt && task.id > existing.id)) {
      latestRequestByScope.set(scope, { requestKey: metadata.requestKey, createdAt: String(task.createdAt), id: task.id });
    }
  }
  const current = [];
  const history = [];
  for (const task of tasks) {
    const metadata = task.metadata || {};
    const ontologyTask = task.type.startsWith("ontology_") && metadata.repository && metadata.ref && metadata.requestKey;
    if (ontologyTask) {
      const scope = String(metadata.tenantId || "") + ":" + metadata.repository + ":" + metadata.ref;
      const latest = latestRequestByScope.get(scope);
      (latest && latest.requestKey === metadata.requestKey ? current : history).push(task);
    } else {
      (task.status === "superseded" ? history : current).push(task);
    }
  }
  return { current: current, history: history };
}

function renderColumns(tasks) {
  columns.replaceChildren();
  const statuses = ["triage", "blocked", "queued", "in_progress", "done", "superseded", "failed", "canceled"];
  for (const status of statuses) {
    const items = tasks.filter(function(task) { return task.status === status; });
    if (items.length === 0 && !["triage", "queued", "in_progress", "done"].includes(status)) continue;
    const column = element("section", "column");
    const heading = element("h2");
    heading.append(document.createTextNode(humanize(status)), textElement("span", "count", String(items.length)));
    column.append(heading);
    if (items.length === 0) column.append(textElement("div", "empty", "No tasks"));
    for (const task of items) column.append(taskCard(task));
    columns.append(column);
  }
}

function taskCard(task) {
  const card = element("button", "card" + (task.status === "superseded" ? " superseded" : ""));
  card.type = "button";
  card.dataset.taskId = task.id;
  card.setAttribute("aria-label", "Open task: " + task.title + ", epoch " + (task.epoch ?? "none"));
  card.append(textElement("span", "card-title", task.title));
  const meta = element("span", "card-meta");
  meta.append(
    textElement("span", "chip", humanize(task.type)),
    textElement("span", "chip", "epoch " + (task.epoch ?? "–")),
    textElement("span", "chip", "attempt " + task.attempt)
  );
  card.append(meta);
  return card;
}

function renderTaskTypes() {
  taskTypeList.replaceChildren();
  document.getElementById("task-type-count").textContent = taskTypes.length + " types";
  renderWorkflowTrees();
  for (const definition of taskTypes) {
    const row = element("article", "type-row");
    const copy = element("div", "type-copy");
    copy.append(
      textElement("span", "type-name", definition.type),
      textElement("span", "type-description", definition.description),
      taskTypeDependencyGroups(definition)
    );
    const meta = element("div", "type-meta");
    meta.append(
      textElement("span", "type-chip", humanize(definition.kind)),
      textElement("span", "type-chip", humanize(definition.defaultAssigneeRole))
    );
    if (definition.dispatchTopic) meta.append(textElement("span", "type-chip", definition.dispatchTopic));
    row.append(copy, meta);
    taskTypeList.append(row);
  }
}

function buildWorkflowTrees(definitions) {
  const byType = new Map(definitions.map(function(definition, index) { return [definition.type, { definition: definition, index: index }]; }));
  const workflowNames = new Set();
  for (const definition of definitions) {
    for (const dependency of definition.dependsOn || []) {
      for (const workflow of dependency.workflows || []) workflowNames.add(workflow);
    }
  }
  return Array.from(workflowNames).sort(function(left, right) {
    return (byType.get(left)?.index ?? Number.MAX_SAFE_INTEGER) - (byType.get(right)?.index ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right);
  }).map(function(workflow) {
    const nodeTypes = new Set();
    const edges = [];
    for (const definition of definitions) {
      for (const dependency of definition.dependsOn || []) {
        if (!(dependency.workflows || []).includes(workflow)) continue;
        nodeTypes.add(dependency.taskType);
        nodeTypes.add(definition.type);
        edges.push({
          from: dependency.taskType,
          to: definition.type,
          relationships: dependency.relationships || [],
          required: dependency.required !== false,
          conditions: dependency.conditions || []
        });
      }
    }
    const reducedEdges = [];
    const collapsedEdges = [];
    edges.forEach(function(edge, index) {
      (hasDependencyPath(edge.from, edge.to, edges, index) ? collapsedEdges : reducedEdges).push(edge);
    });
    const incoming = new Map(Array.from(nodeTypes, function(type) { return [type, []]; }));
    const outgoing = new Map(Array.from(nodeTypes, function(type) { return [type, []]; }));
    for (const edge of reducedEdges) {
      incoming.get(edge.to)?.push(edge);
      outgoing.get(edge.from)?.push(edge);
    }
    const order = function(type) { return byType.get(type)?.index ?? Number.MAX_SAFE_INTEGER; };
    for (const values of outgoing.values()) values.sort(function(left, right) { return order(left.to) - order(right.to) || left.to.localeCompare(right.to); });
    const rootTypes = Array.from(nodeTypes).filter(function(type) { return (incoming.get(type) || []).length === 0; })
      .sort(function(left, right) { return order(left) - order(right) || left.localeCompare(right); });
    return {
      name: workflow,
      typeCount: nodeTypes.size,
      edgeCount: edges.length,
      roots: rootTypes.map(function(type) {
        return workflowTreeNode(type, byType, incoming, outgoing, collapsedEdges, new Set());
      })
    };
  });
}

function hasDependencyPath(from, target, edges, skippedIndex) {
  const pending = [from];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    edges.forEach(function(edge, index) {
      if (index !== skippedIndex && edge.from === current && !visited.has(edge.to)) pending.push(edge.to);
    });
  }
  return false;
}

function workflowTreeNode(type, byType, incoming, outgoing, collapsedEdges, ancestors) {
  const nextAncestors = new Set(ancestors);
  const cycle = nextAncestors.has(type);
  nextAncestors.add(type);
  const entry = byType.get(type);
  return {
    type: type,
    definition: entry?.definition || { type: type, kind: "dispatchable", description: "Unregistered task type" },
    incoming: incoming.get(type) || [],
    collapsedDependencies: collapsedEdges.filter(function(edge) { return edge.to === type; }),
    cycle: cycle,
    children: cycle ? [] : (outgoing.get(type) || []).map(function(edge) {
      return { edge: edge, node: workflowTreeNode(edge.to, byType, incoming, outgoing, collapsedEdges, nextAncestors) };
    })
  };
}

function renderWorkflowTrees() {
  workflowTreeList.replaceChildren();
  const workflows = buildWorkflowTrees(taskTypes);
  document.getElementById("workflow-count").textContent = workflows.length + (workflows.length === 1 ? " workflow" : " workflows");
  if (!workflows.length) {
    workflowTreeList.append(textElement("p", "workflow-empty", "No workflow dependencies are declared."));
    return;
  }
  for (const workflow of workflows) {
    const card = element("article", "workflow-tree");
    const header = element("header", "workflow-tree-header");
    header.append(
      textElement("span", "workflow-tree-name", workflow.name),
      textElement("span", "workflow-tree-count", workflow.typeCount + " types · " + workflow.edgeCount + " declared links")
    );
    const body = element("div", "workflow-tree-body");
    const roots = element("ol", "workflow-tree-root");
    for (const root of workflow.roots) roots.append(renderWorkflowBranch(root, null));
    body.append(roots);
    card.append(header, body);
    workflowTreeList.append(card);
  }
}

function renderWorkflowBranch(node, incomingEdge) {
  const branch = element("li", "workflow-branch");
  for (const trigger of node.definition.triggeredBy || []) branch.append(workflowTrigger(trigger));
  if (incomingEdge) {
    const connector = element("div", "workflow-connector");
    connector.append(textElement("strong", "", "↓ unblocks"));
    const details = [];
    if (incomingEdge.relationships.length) details.push(incomingEdge.relationships.map(humanize).join(" + "));
    details.push(incomingEdge.required ? "required" : "optional");
    connector.append(textElement("span", "", details.join(" · ")));
    if (incomingEdge.conditions.length) {
      const condition = incomingEdge.conditions.join("; ");
      connector.append(textElement("span", "workflow-connector-condition", /^when\\b/i.test(condition) ? condition : "when " + condition));
    }
    branch.append(connector);
  }
  const card = element("div", "workflow-node" + (node.definition.kind === "aggregate" ? " aggregate" : ""));
  const top = element("div", "workflow-node-top");
  top.append(
    textElement("span", "workflow-node-name", node.type),
    textElement("span", "workflow-node-badge", node.definition.kind === "aggregate" && node.children.length === 0 ? "completes workflow" : humanize(node.definition.kind))
  );
  card.append(top, textElement("span", "workflow-node-description", node.definition.description));
  if (node.collapsedDependencies.length) {
    card.append(textElement(
      "span",
      "workflow-node-gates",
      "Also directly waits for: " + node.collapsedDependencies.map(function(edge) { return edge.from; }).join(", ")
    ));
  }
  if (node.cycle) card.append(textElement("span", "workflow-node-gates", "Cycle detected; branch stopped."));
  branch.append(card);
  if (node.children.length) {
    const children = element("ol", "workflow-children");
    for (const child of node.children) children.append(renderWorkflowBranch(child.node, child.edge));
    branch.append(children);
  }
  return branch;
}

function taskTypeDependencyGroups(definition) {
  const groups = element("div", "type-dependency-groups");
  groups.append(
    taskTypeTriggerGroup(definition.triggeredBy || []),
    taskTypeDependencyGroup("Prerequisite tasks", definition.dependsOn || [], "No prerequisite task"),
    taskTypeDependencyGroup("Required by", definition.requiredBy || [], "Does not unlock another type")
  );
  return groups;
}

function taskTypeTriggerGroup(triggers) {
  const group = element("section", "type-dependency-group");
  group.append(textElement("span", "type-dependency-label", "Triggered by"));
  const list = element("div", "type-dependency-list");
  if (!triggers.length) list.append(textElement("span", "type-dependency-empty", "No declared workflow trigger"));
  for (const trigger of triggers) {
    const item = element("div", "type-dependency");
    const details = [];
    if ((trigger.workflows || []).length) details.push("workflow: " + trigger.workflows.map(humanize).join(", "));
    if ((trigger.conditions || []).length) details.push(trigger.conditions.join("; "));
    item.append(
      textElement("span", "type-dependency-name", trigger.source),
      textElement("span", "type-dependency-detail", [trigger.description].concat(details).filter(Boolean).join(" · "))
    );
    list.append(item);
  }
  group.append(list);
  return group;
}

function workflowTrigger(trigger) {
  const card = element("div", "workflow-trigger");
  card.append(
    textElement("strong", "", "Triggered by"),
    textElement("span", "workflow-trigger-source", trigger.source),
    textElement("span", "workflow-trigger-description", trigger.description)
  );
  if ((trigger.conditions || []).length) {
    card.append(textElement("span", "workflow-connector-condition", trigger.conditions.join("; ")));
  }
  return card;
}

function taskTypeDependencyGroup(label, dependencies, emptyMessage) {
  const group = element("section", "type-dependency-group");
  group.append(textElement("span", "type-dependency-label", label));
  const list = element("div", "type-dependency-list");
  if (dependencies.length === 0) list.append(textElement("span", "type-dependency-empty", emptyMessage));
  for (const dependency of dependencies) {
    const item = element("div", "type-dependency");
    const details = [];
    details.push((dependency.relationships || []).map(humanize).join(" + "));
    if (dependency.required) details.push("required");
    if ((dependency.workflows || []).length) details.push("workflow: " + dependency.workflows.map(humanize).join(", "));
    if ((dependency.conditions || []).length) details.push(dependency.conditions.join("; "));
    item.append(
      textElement("span", "type-dependency-name", dependency.taskType),
      textElement("span", "type-dependency-detail", details.filter(Boolean).join(" · "))
    );
    list.append(item);
  }
  group.append(list);
  return group;
}

function renderSelectedTask() {
  const taskId = selectedTaskId();
  if (!taskId) {
    if (dialog.open) dialog.close();
    return;
  }
  const task = taskById(taskId);
  if (!task) return;
  detailTitle.textContent = task.title;
  detailEyebrow.textContent = humanize(task.type) + " · " + shortId(task.id);
  detailBody.replaceChildren();
  detailBody.append(summary(task));
  detailBody.append(relationshipSection(task));
  detailBody.append(metadataSection(task));
  detailBody.append(activitySection(task));
  if (!dialog.open) dialog.showModal();
}

function summary(task) {
  const grid = element("section", "summary-grid");
  grid.append(summaryItem("Status", humanize(task.status), "status status-" + task.status));
  grid.append(summaryItem("Assignee", humanize(task.assigneeRole)));
  grid.append(summaryItem("Attempt", String(task.attempt)));
  grid.append(summaryItem("Epoch", String(task.epoch ?? "–")));
  grid.append(summaryItem("Created", formatTime(task.createdAt)));
  grid.append(summaryItem("Updated", formatTime(task.updatedAt)));
  return grid;
}

function summaryItem(label, value, valueClass) {
  const item = element("div", "summary-item");
  item.append(textElement("span", "label", label), textElement("span", valueClass || "value", value));
  return item;
}

function relationshipSection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Dependencies & relationships"));
  const list = element("div", "relationship-list");
  const relationships = [];
  if (task.parentTaskId) relationships.push({ direction: "Parent", taskId: task.parentTaskId, relationship: "parent" });
  for (const child of boardState.tasks.filter(function(item) { return item.parentTaskId === task.id; })) {
    relationships.push({ direction: "Child", taskId: child.id, relationship: "child" });
  }
  for (const dependency of boardState.dependencies || []) {
    if (dependency.taskId === task.id) relationships.push({ direction: "Depends on", taskId: dependency.dependsOnTaskId, relationship: dependency.relationship, required: dependency.required });
    if (dependency.dependsOnTaskId === task.id) relationships.push({ direction: "Required by", taskId: dependency.taskId, relationship: dependency.relationship, required: dependency.required });
  }
  if (relationships.length === 0) list.append(textElement("p", "empty-detail", "No task relationships."));
  for (const relationship of relationships) {
    const related = taskById(relationship.taskId);
    const row = element("button", "relationship");
    row.type = "button";
    row.dataset.taskId = relationship.taskId;
    row.append(
      textElement("span", "relation-direction", relationship.direction),
      textElement("span", "relation-title", related ? related.title : shortId(relationship.taskId)),
      textElement("span", "relation-type", relationship.relationship + (relationship.required ? " · required" : ""))
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function metadataSection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Metadata"));
  const list = element("dl", "metadata");
  const entries = [
    ["Task ID", task.id], ["Dedupe key", task.dedupeKey], ["Required", String(task.required)],
    ["Dispatch topic", task.dispatchTopic || "–"]
  ].concat(Object.entries(task.metadata || {}).sort(function(a, b) { return a[0].localeCompare(b[0]); }));
  for (const entry of entries) {
    list.append(textElement("dt", "", humanize(entry[0])));
    const value = element("dd");
    if (typeof entry[1] === "string" && /^https:\\/\\//.test(entry[1])) {
      const link = textElement("a", "", entry[1]);
      link.href = entry[1]; link.target = "_blank"; link.rel = "noreferrer";
      value.append(link);
    } else {
      value.textContent = formatValue(entry[1]);
    }
    list.append(value);
  }
  section.append(list);
  return section;
}

function activitySection(task) {
  const section = element("section", "section");
  section.append(textElement("h3", "", "Comments & activity"));
  const timeline = element("div", "timeline");
  const events = boardEvents.filter(function(event) { return event.taskId === task.id; }).slice().reverse();
  if (events.length === 0) timeline.append(textElement("p", "empty-detail", "No comments or activity recorded."));
  for (const event of events) {
    const row = element("article", "event");
    const top = element("div", "event-top");
    top.append(textElement("span", "event-type", eventLabel(event)), textElement("time", "event-time", formatTime(event.at)));
    row.append(top);
    if (event.payload && Object.keys(event.payload).length > 0) row.append(textElement("pre", "event-payload", JSON.stringify(event.payload, null, 2)));
    timeline.append(row);
  }
  section.append(timeline);
  return section;
}

function eventLabel(event) {
  const labels = {
    "task.created": "Task created", "task.queued": "Queued for execution", "task.transitioned": "Status changed",
    "task.dependency_added": "Dependency linked", "run.step": "Run comment", "review.completed": "Review completed",
    "publish.completed": "Publication comment", "github.issue_opened": "GitHub issue received"
    ,"ontology.graph_created": "Ontology graph created", "ontology.failed": "Ontology build failed"
  };
  return labels[event.type] || humanize(event.type);
}

function renderLog(tasks) {
  const taskIds = new Set(tasks.map(function(task) { return task.id; }));
  log.textContent = boardEvents.filter(function(event) { return !event.taskId || taskIds.has(event.taskId); }).slice(-12).reverse().map(function(event) {
    const task = event.taskId ? taskById(event.taskId) : null;
    return formatTime(event.at) + "  " + event.type + (task ? "  " + task.title : "");
  }).join("\\n");
}

function selectedTaskId() {
  const match = location.hash.match(/^#task=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function openTask(taskId) { location.hash = "task=" + encodeURIComponent(taskId); }
function closeTask() {
  history.replaceState(null, "", location.pathname + location.search);
  if (dialog.open) dialog.close();
}
function taskById(taskId) { return boardState.tasks.find(function(task) { return task.id === taskId; }); }
function shortId(value) { return value.length > 34 ? value.slice(0, 18) + "…" + value.slice(-12) : value; }
function humanize(value) { return String(value).replace(/[._-]+/g, " ").replace(/\\b\\w/g, function(char) { return char.toUpperCase(); }); }
function formatTime(value) { return value ? new Date(value).toLocaleString() : "–"; }
function formatValue(value) { return typeof value === "object" ? JSON.stringify(value) : String(value ?? "–"); }
function element(tag, className) { const node = document.createElement(tag); if (className) node.className = className; return node; }
function textElement(tag, className, text) { const node = element(tag, className); node.textContent = text; return node; }

columns.addEventListener("click", function(event) {
  const card = event.target.closest("[data-task-id]");
  if (card) openTask(card.dataset.taskId);
});
detailBody.addEventListener("click", function(event) {
  const relationship = event.target.closest("[data-task-id]");
  if (relationship) openTask(relationship.dataset.taskId);
});
document.getElementById("close-detail").addEventListener("click", closeTask);
dialog.addEventListener("cancel", function(event) { event.preventDefault(); closeTask(); });
dialog.addEventListener("click", function(event) { if (event.target === dialog) closeTask(); });
window.addEventListener("hashchange", renderSelectedTask);
document.getElementById("toolbar").addEventListener("click", function(event) {
  const action = event.target.dataset.demo;
  if (action === "pr") postDemo({ repository: "omlabs/example", pullRequestNumber: ++nextPr, headSha: "sha-" + nextPr + "-1" });
  if (action === "issue") postDemo({ repository: "omlabs/example", issueNumber: ++nextIssue, title: "Demo issue " + nextIssue });
  if (action === "push") postDemo({ repository: "omlabs/example", pullRequestNumber: 42, headSha: "sha-42-" + Date.now().toString(36) });
});
graphControls.addEventListener("click", function(event) {
  const filter = event.target.closest("[data-filter-group]");
  if (filter) toggleGraphFilter(filter.dataset.filterGroup, filter.dataset.filterType);
});
ontologyGraph.addEventListener("click", function(event) {
  if (event.target !== ontologyGraph || !ontologyViewState.selected) return;
  ontologyViewState.selected = null;
  renderOntology();
});
document.getElementById("context-query").addEventListener("submit", async function(event) {
  event.preventDefault();
  const graph = ontologyState.latest;
  if (!graph) return;
  const question = document.getElementById("context-question").value.trim();
  contextResults.replaceChildren(textElement("p", "empty-detail", "Loading cited context…"));
  try {
    const response = await fetch(API + "/ontology/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: graph.repository, ref: graph.ref, question: question })
    });
    if (!response.ok) throw new Error("Context query failed with " + response.status);
    contextState = await response.json();
  } catch (error) {
    contextState = { error: error instanceof Error ? error.message : String(error) };
  }
  renderContextResults();
});
async function postDemo(body) {
  await fetch(API + "/dev/webhooks/github", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await refresh();
}

refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
}
