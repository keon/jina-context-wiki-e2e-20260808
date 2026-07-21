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
  .page-nav { display: flex; gap: .35rem; margin-bottom: 1.25rem; border-bottom: 1px solid #202637; }
  .page-nav a { padding: .65rem .15rem .6rem; margin-right: 1rem; color: #78849a; text-decoration: none; font-size: .76rem; font-weight: 650; border-bottom: 2px solid transparent; }
  .page-nav a:hover { color: #c5ccda; }
  .page-nav a.active { color: #f1f3f7; border-bottom-color: #809cff; }
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
  .superseded { opacity: .48; }
  .empty { padding: 1.5rem .5rem; color: #586277; text-align: center; font-size: .72rem; }
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
  .graph-filter-chip:focus-visible, .graph-reset:focus-visible { outline: 2px solid #9bb2ff; outline-offset: 2px; }
  .graph-reset { align-self: start; border-radius: .5rem; background: #151c29; }
  .graph-reset:disabled { opacity: .42; cursor: default; }
  .graph-wrap { min-height: 590px; overflow: auto; background: radial-gradient(circle at 50% 50%, #182036, #0d1119 66%); }
  #ontology-graph { display: block; width: 100%; min-width: 900px; height: 590px; touch-action: pan-x pan-y pinch-zoom; user-select: none; }
  .assertion-review { border: 1px solid #252d40; border-radius: .85rem; background: #10151f; overflow: hidden; }
  .assertion-review > summary { padding: .8rem 1rem; color: #cbd3e1; cursor: pointer; font-size: .72rem; font-weight: 700; }
  .assertion-review-toolbar { display: flex; gap: .55rem; flex-wrap: wrap; padding: .8rem 1rem; }
  .assertion-review-item { border: 1px solid #2a3449; border-radius: .65rem; background: #111823; padding: .72rem; }
  .assertion-review-item header, .assertion-actions { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
  .assertion-review-item p { color: #aeb8c9; font-size: .7rem; }
  .assertion-relations { color: #8e9bb0; font-size: .64rem; }
  .ontology-details { display: grid; gap: .7rem; padding: 1rem; border-top: 1px solid #252d40; }
  .ontology-item { border: 1px solid #262e42; border-radius: .7rem; background: #121722; padding: .72rem; }
  .ontology-item strong { display: block; font-size: .74rem; }
  .ontology-item span { display: block; margin-top: .3rem; color: #7e8aa0; font-size: .66rem; line-height: 1.45; }
  .ontology-item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .7rem; }
  .ontology-item-type { flex: 0 0 auto; border: 1px solid #36415a; border-radius: 99px; padding: .15rem .4rem; color: #8da1c4; font-size: .58rem; }
  .ontology-explanation { margin: 0; color: #cbd3e1; font-size: .72rem; line-height: 1.55; }
  .ontology-inspector-section { margin-top: .85rem; }
  .ontology-inspector-section h3 { margin: 0 0 .48rem; color: #8d9bb2; font-size: .6rem; letter-spacing: .09em; text-transform: uppercase; }
  .ontology-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .55rem; margin-top: .7rem; }
  .ontology-detail-field { border: 1px solid #242d40; border-radius: .55rem; background: #0f141e; padding: .55rem .6rem; }
  .ontology-detail-field .label { margin-bottom: .25rem; }
  .ontology-detail-field .value { color: #d3dae6; font-size: .68rem; line-height: 1.45; }
  .ontology-confidence { border: 1px solid #2d3d59; border-radius: .6rem; background: #101827; padding: .62rem .68rem; }
  .ontology-confidence-top { display: flex; align-items: baseline; justify-content: space-between; gap: .7rem; }
  .ontology-confidence-top .label { margin: 0; }
  .ontology-confidence-value { color: #dce5f5; font: .8rem ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 750; }
  .ontology-confidence-meter { height: .28rem; margin-top: .48rem; border-radius: 99px; background: #252e40; overflow: hidden; }
  .ontology-confidence-fill { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6e91e8, #66d6bd); }
  .ontology-confidence-note { margin: .42rem 0 0; color: #75839a; font-size: .62rem; line-height: 1.45; }
  .ontology-evidence-list { display: flex; flex-wrap: wrap; gap: .38rem; margin: 0; padding: 0; list-style: none; }
  .ontology-evidence { border: 1px solid #34425a; border-radius: .42rem; background: #151d2a; padding: .3rem .42rem; color: #aebbd0; font: .62rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .ontology-relationship-list { display: grid; gap: .42rem; }
  .ontology-relationship { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .3rem .7rem; width: 100%; border: 1px solid #2a3449; border-radius: .58rem; background: #111823; padding: .55rem .62rem; color: inherit; text-align: left; cursor: pointer; }
  .ontology-relationship:hover { border-color: #62769c; background: #172133; }
  .ontology-relationship:focus-visible { outline: 2px solid #9bb2ff; outline-offset: 2px; }
  .ontology-relationship-title { color: #d6deeb; font-size: .67rem; font-weight: 700; }
  .ontology-relationship-meta { color: #8a99b1; font: .6rem ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
  .ontology-relationship-explanation { grid-column: 1 / -1; color: #74839b; font-size: .61rem; line-height: 1.42; }
  .assertion-review-list { display: grid; gap: .65rem; padding: .8rem; }
  .assertion-review-card { display: grid; gap: .55rem; border: 1px solid #292929; border-radius: .55rem; background: #101010; padding: .75rem; }
  .assertion-review-card strong { color: #ddd; font-size: .7rem; }
  .assertion-review-card p { margin: 0; color: #999; font-size: .63rem; line-height: 1.5; }
  .assertion-review-fields { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
  .assertion-review-fields select, .assertion-review-fields input { min-width: 0; border: 1px solid #303030; border-radius: .35rem; background: #0b0b0b; color: #bbb; padding: .45rem; font-size: .62rem; }
  .assertion-review-actions { display: flex; gap: .4rem; }
  .ontology-item .ontology-item-type, .ontology-item .ontology-confidence span, .ontology-item .ontology-relationship span { margin-top: 0; }
  .plane-key { display: flex; gap: .8rem; align-items: center; color: #7f8ca2; font-size: .66rem; }
  .plane-key span::before { content: ""; display: inline-block; width: 1.4rem; margin-right: .35rem; border-top: 2px solid #6495ed; vertical-align: middle; }
  .plane-key .knowledge::before { border-top-color: #d88fff; border-top-style: dashed; }
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
  @media (max-width: 640px) { .shell { padding: 1rem; } .topbar { flex-direction: column; } .workflow-grid, .type-row, .graph-filter-row { grid-template-columns: 1fr; } .workflow-grid { padding: .7rem; } .graph-filter-label { padding-top: 0; } .graph-reset { justify-self: start; } .detail-body, .detail-header { padding-left: 1rem; padding-right: 1rem; } }
</style>
<style>
  :root {
    color-scheme: dark;
    --bg: #080808;
    --panel: #0d0d0d;
    --surface: #111111;
    --surface-hover: #151515;
    --border: #242424;
    --border-strong: #343434;
    --text: #ededed;
    --muted: #8a8a8a;
    --subtle: #5f5f5f;
    --accent: #8b7cf6;
    --accent-soft: rgb(139 124 246 / 12%);
    --success: #45c98f;
    --danger: #ef6b73;
    --warning: #d6a85f;
    --radius: 7px;
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  * { scrollbar-color: #303030 transparent; }
  ::selection { background: rgb(139 124 246 / 28%); }
  body { background: var(--bg); color: var(--text); }
  button, input { font: inherit; }
  button { transition: border-color 120ms ease, background 120ms ease, color 120ms ease, opacity 120ms ease; }
  .shell { max-width: 1480px; margin: 0 auto; padding: 0 28px 48px; }
  .app-header { position: sticky; top: 0; z-index: 20; margin: 0 -28px 28px; padding: 0 28px; border-bottom: 1px solid var(--border); background: rgb(8 8 8 / 88%); backdrop-filter: blur(18px) saturate(130%); }
  .topbar { min-height: 58px; margin: 0; align-items: center; }
  .brand-lockup { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand-mark { display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid #383838; border-radius: 6px; background: #f2f2f2; color: #090909; font-size: 11px; font-weight: 800; letter-spacing: -.04em; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 28%); }
  .eyebrow { margin: 0 0 1px; color: var(--subtle); font-size: 9px; font-weight: 650; letter-spacing: .12em; }
  h1 { color: var(--text); font-size: 14px; font-weight: 620; letter-spacing: -.015em; }
  #connection { gap: 7px; color: var(--muted); font-size: 11px; }
  .pulse { width: 6px; height: 6px; background: var(--success); box-shadow: none; }
  .pulse.offline { background: var(--danger); box-shadow: none; }
  .page-nav { gap: 2px; margin: 0; padding: 0 0 9px 35px; border: 0; }
  .page-nav a { margin: 0; padding: 6px 9px; border: 1px solid transparent; border-radius: 6px; color: #777; font-size: 11px; font-weight: 520; line-height: 1; }
  .page-nav a:hover { background: #111; color: #c7c7c7; }
  .page-nav a.active { border-color: var(--border); background: #141414; color: #f1f1f1; }
  .graph-reset { border: 1px solid var(--border); border-radius: 6px; background: #0d0d0d; padding: 6px 9px; color: #a5a5a5; font-size: 10px; }
  .graph-reset:hover { border-color: var(--border-strong); background: #151515; color: var(--text); }

  .columns { grid-template-columns: repeat(auto-fit, minmax(235px, 1fr)); gap: 12px; }
  .column { min-height: 180px; border-color: var(--border); border-radius: var(--radius); background: var(--panel); padding: 7px; }
  .column h2 { margin: 4px 5px 9px; color: #757575; font-size: 10px; font-weight: 620; letter-spacing: .08em; }
  .count { min-width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 5px; background: #111; color: #777; font-size: 9px; }
  .card { margin-bottom: 6px; border-color: var(--border); border-radius: 6px; background: var(--surface); padding: 10px; box-shadow: none; }
  .card:hover { transform: none; border-color: #3b3b3b; background: var(--surface-hover); }
  .card:focus-visible, .graph-filter-chip:focus-visible, .graph-reset:focus-visible, .ontology-relationship:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .card-title { color: #d8d8d8; font-size: 12px; font-weight: 540; line-height: 1.4; }
  .card-meta { gap: 6px; margin-top: 8px; color: #6f6f6f; font-size: 9px; }
  .chip, .workflow-node-badge { border-color: #292929; border-radius: 4px; background: #0e0e0e; padding: 2px 5px; }
  .superseded { opacity: .4; }
  .empty { color: #4f4f4f; font-size: 11px; }

  .task-panel, .workflow-panel { border-color: var(--border); border-radius: var(--radius); background: var(--panel); }
  .workflow-panel { margin-bottom: 12px; }
  .task-panel-header { min-height: 43px; padding: 0 14px; border-color: var(--border); }
  .task-panel-header h2 { color: #a0a0a0; font-size: 10px; font-weight: 620; letter-spacing: .08em; }
  .task-count { color: #626262; font-size: 10px; }
  .workflow-help { padding: 12px 14px 0; color: #707070; font-size: 10px; }
  .workflow-grid { gap: 10px; padding: 12px; }
  .workflow-tree { border-color: var(--border); border-radius: 6px; background: #0f0f0f; }
  .workflow-tree-header { padding: 9px 10px; border-color: var(--border); }
  .workflow-tree-name { color: #cfcfcf; font-size: 11px; }
  .workflow-tree-count { color: #5f5f5f; font-size: 9px; }
  .workflow-tree-body { padding: 10px; }
  .workflow-children { border-color: #2d2d2d; }
  .workflow-children > .workflow-branch::before { border-color: #2d2d2d; }
  .workflow-connector { color: #686868; font-size: 9px; }
  .workflow-connector strong { color: #9187d8; font-size: 9px; }
  .workflow-connector-condition { color: var(--warning); }
  .workflow-trigger { border-color: #2d2b3b; border-radius: 5px; background: #121117; color: #8a8a8a; font-size: 9px; }
  .workflow-trigger strong { color: #9e94ec; }
  .workflow-trigger-source { color: #c9c9c9; }
  .workflow-trigger-description { color: #6c6c6c; }
  .workflow-node, .workflow-node.aggregate { border-color: #292929; border-radius: 5px; background: #131313; }
  .workflow-node.aggregate { border-color: #3a374a; background: #151419; }
  .workflow-node-name { color: #d6d6d6; font-size: 10px; }
  .workflow-node-description { color: #737373; font-size: 9px; }
  .workflow-node-gates { color: #9187aa; font-size: 9px; }
  .workflow-empty { color: #535353; font-size: 10px; }
  .type-row { border-color: var(--border); padding: 13px 14px; }
  .type-name { color: #d3d3d3; font-size: 11px; }
  .type-description { color: #797979; font-size: 10px; }

  .ontology-shell { gap: 12px; }
  .ontology-summary { gap: 8px; }
  .ontology-stat { border-color: var(--border); border-radius: 6px; background: var(--panel); padding: 11px 12px; }
  .ontology-stat .label { margin: 0; }
  .ontology-stat strong { margin-top: 7px; color: #dcdcdc; font-size: 15px; font-weight: 560; letter-spacing: -.02em; }
  .ontology-card { border-color: var(--border); border-radius: var(--radius); background: var(--panel); }
  .ontology-card header { align-items: center; padding: 12px 14px; border-color: var(--border); }
  .ontology-card h2 { color: #dcdcdc; font-size: 12px; font-weight: 560; }
  .ontology-card p { color: #6f6f6f; font-size: 10px; }
  .plane-key { color: #666; font-size: 9px; }
  .plane-key span::before { width: 14px; border-color: #7485bf; }
  .plane-key .knowledge::before { border-color: #9b83bc; }
  .graph-controls { gap: 8px; padding: 10px 14px; border-color: var(--border); background: #0a0a0a; }
  .graph-filter-row { grid-template-columns: 72px minmax(0, 1fr) auto; gap: 8px; }
  .graph-filter-label { color: #656565; font-size: 8px; }
  .graph-filter-list { gap: 5px; }
  .graph-filter-chip { border-color: #292929; border-radius: 5px; background: #111; padding: 4px 7px; color: #9b9b9b; font-size: 9px; }
  .graph-filter-chip::before { width: 5px; height: 5px; margin-right: 5px; background: #7a89bd; }
  .graph-filter-chip[data-filter-group="edge"]::before { background: #9d82b8; }
  .graph-filter-chip[aria-pressed="false"] { border-color: #202020; background: #0b0b0b; color: #515151; }
  .graph-filter-chip:hover { border-color: #3b3b3b; background: #171717; color: #d0d0d0; }
  .graph-reset { font-size: 9px; }
  .graph-wrap { min-height: 590px; background-color: #0a0a0a; background-image: radial-gradient(circle, #292929 1px, transparent 1px); background-size: 20px 20px; }
  .ontology-details { gap: 8px; padding: 12px 14px; border-color: var(--border); background: #0b0b0b; }
  .ontology-item { border-color: var(--border); border-radius: 6px; background: #101010; padding: 11px; }
  .ontology-item strong { font-size: 11px; font-weight: 560; }
  .ontology-item span { color: #777; font-size: 9px; }
  .ontology-item-type { border-color: #303030; border-radius: 4px; color: #888; }
  .ontology-explanation { color: #b9b9b9; font-size: 10px; }
  .ontology-inspector-section h3 { color: #666; font-size: 8px; }
  .ontology-detail-field { border-color: #222; border-radius: 5px; background: #0b0b0b; }
  .ontology-detail-field .value { color: #c7c7c7; font-size: 9px; }
  .ontology-confidence { border-color: #292735; border-radius: 5px; background: #0e0d12; }
  .ontology-confidence-value { color: #d2d2d2; font-size: 11px; }
  .ontology-confidence-meter { background: #242424; }
  .ontology-confidence-fill { background: var(--accent); }
  .ontology-confidence-note { color: #6d6d6d; font-size: 9px; }
  .ontology-evidence { border-color: #292929; border-radius: 4px; background: #0c0c0c; color: #929292; font-size: 9px; }
  .ontology-relationship { border-color: #252525; border-radius: 5px; background: #0d0d0d; }
  .ontology-relationship:hover { border-color: #3b3b3b; background: #131313; }
  .ontology-relationship-title { color: #c7c7c7; font-size: 9px; }
  .ontology-relationship-meta, .ontology-relationship-explanation { color: #6d6d6d; font-size: 9px; }

  .context-answer, .context-call, .trace-chain, .trace-fact { border-color: var(--border); border-radius: 6px; background: var(--panel); }
  .context-answer-label, .trace-answer-label-cause, .trace-fact-label { color: #9e94ec; }
  .context-answer-text { color: #cfcfcf; font-size: 11px; }
  .context-claim { border-color: #554c93; }
  .context-notice { border-color: #3a3224; border-radius: 5px; background: #13110e; color: #a9906d; }
  .context-call h3 { color: #858585; font-size: 9px; }
  .context-result { border-color: var(--border); }
  .context-result strong { font-size: 10px; }
  .context-result span, .trace-changes, .trace-evidence { color: #707070; font-size: 9px; }
  .trace-chain a { color: #a59bf2; }
  .trace-arrow { color: #5f5f5f; }
  .trace-fact-value { color: #bcbcbc; font-size: 10px; }

  dialog { border-color: #303030; border-radius: 10px; background: #0d0d0d; color: var(--text); box-shadow: 0 30px 100px rgb(0 0 0 / 70%); }
  dialog::backdrop { background: rgb(0 0 0 / 70%); backdrop-filter: blur(4px); }
  .detail-header { padding: 16px 18px; border-color: var(--border); background: rgb(13 13 13 / 94%); }
  .detail-title { font-size: 16px; font-weight: 580; }
  .close { width: 28px; height: 28px; border-color: var(--border); border-radius: 5px; background: #121212; color: #999; }
  .close:hover { border-color: #3b3b3b; color: #fff; }
  .detail-body { padding: 16px 18px 22px; }
  .summary-grid { gap: 7px; }
  .summary-item { border-color: var(--border); border-radius: 5px; background: #101010; }
  .label { color: #626262; font-size: 8px; }
  .value { color: #c7c7c7; font-size: 10px; }
  .status::before { width: 6px; height: 6px; }
  .status-done::before { background: var(--success); }
  .status-in_progress::before, .status-queued::before { background: var(--accent); }
  .status-failed::before, .status-canceled::before { background: var(--danger); }
  .status-blocked::before, .status-triage::before { background: var(--warning); }
  .section h3 { color: #777; font-size: 9px; }
  .relationship { border-color: var(--border); border-radius: 5px; background: #101010; }
  .relationship:hover { border-color: #3b3b3b; }
  .relation-direction, .relation-type { color: #6d6d6d; font-size: 9px; }
  .relation-title { color: #c7c7c7; font-size: 10px; }
  .metadata { border-color: var(--border); border-radius: 5px; }
  .metadata dt, .metadata dd { border-color: var(--border); font-size: 9px; }
  .metadata dt { color: #686868; background: #101010; }
  .metadata dd { color: #bcbcbc; background: #0c0c0c; }
  .metadata a { color: #a59bf2; }
  .event { border-color: #333; }
  .event-type { color: #bfbfbf; font-size: 10px; }
  .event-time, .event-payload, .empty-detail { color: #656565; font-size: 9px; }

  @media (max-width: 700px) {
    .shell { padding: 0 14px 28px; }
    .app-header { margin: 0 -14px 20px; padding: 0 14px; }
    .topbar { min-height: 52px; flex-direction: row; }
    .page-nav { padding-left: 0; overflow-x: auto; }
    #connection-text { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .workflow-grid, .type-row, .graph-filter-row { grid-template-columns: 1fr; }
    .graph-filter-label { padding-top: 0; }
    .ontology-card header { align-items: flex-start; flex-direction: column; }
  }
</style>
<style>
  /* Reference-matched application shell */
  body { min-width: 320px; overflow-x: hidden; }
  .shell { max-width: none; padding: 0 14px 32px; }
  .app-header { margin: 0 -14px 24px; padding: 0 14px; }
  .topbar { min-height: 56px; justify-content: flex-start; gap: 24px; }
  .brand-lockup { flex: 0 0 auto; padding-right: 22px; border-right: 1px solid var(--border); }
  .brand-mark { width: 32px; height: 32px; border-color: #343434; background: linear-gradient(#171717, #101010); color: #f2f2f2; font-size: 12px; }
  .brand-name { color: #f3f3f3; font-size: 15px; font-weight: 650; letter-spacing: -.02em; }
  .page-nav { flex: 1 1 auto; align-self: stretch; align-items: center; gap: 12px; padding: 0; overflow: visible; }
  .page-nav a { position: relative; display: grid; align-items: center; height: 100%; padding: 0 10px; border: 0; border-radius: 0; color: #888; font-size: 12px; }
  .page-nav a:hover { background: transparent; color: #d0d0d0; }
  .page-nav a.active { border: 0; background: transparent; color: #f2f2f2; }
  .page-nav a.active::after { content: ""; position: absolute; right: 6px; bottom: 0; left: 6px; height: 2px; background: var(--accent); }
  #connection { flex: 0 0 auto; margin-left: auto; }
  #connection-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; min-height: 48px; margin: 0 10px 18px; }
  .page-heading h1 { margin: 0; color: #efefef; font-size: 20px; font-weight: 610; letter-spacing: -.035em; }
  .page-heading p { margin: 5px 0 0; color: #777; font-size: 11px; }
  .primary-button, .secondary-button, .danger-button, .repository-button { min-height: 32px; border: 1px solid var(--border); border-radius: 6px; background: #101010; padding: 0 11px; color: #bcbcbc; cursor: pointer; font-size: 10px; }
  .primary-button { border-color: #7768dc; background: #705ee0; color: white; }
  .primary-button:hover { background: #7d6ce7; }
  .secondary-button:hover, .repository-button:hover { border-color: #3b3b3b; background: #151515; color: #eee; }
  .danger-button { border-color: #53262a; color: #ef777f; }
  .primary-button:disabled, .secondary-button:disabled, .danger-button:disabled {
    border-color: #272727; background: #101010; color: #5f5f5f; cursor: not-allowed; opacity: .7;
  }
  .primary-button:disabled:hover, .secondary-button:disabled:hover, .danger-button:disabled:hover { border-color: #272727; background: #101010; color: #5f5f5f; }

  .page-filters { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; padding: 0 2px; }
  .page-filters select, .search-control, .demo-menu > summary, .graph-control-button, .graph-zoom {
    min-height: 36px; border: 1px solid var(--border); border-radius: 6px; background: #0d0d0d; color: #aaa; font-size: 10px;
  }
  .page-filters select { appearance: none; min-width: 126px; padding: 0 30px 0 11px; background-image: linear-gradient(45deg, transparent 50%, #777 50%), linear-gradient(135deg, #777 50%, transparent 50%); background-position: calc(100% - 14px) 15px, calc(100% - 10px) 15px; background-size: 4px 4px; background-repeat: no-repeat; }
  .search-control { display: flex; align-items: center; gap: 8px; width: min(310px, 30vw); padding: 0 10px; }
  .search-control span { color: #727272; font-size: 16px; line-height: 1; transform: rotate(-18deg); }
  .search-control input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: #ddd; font-size: 10px; }
  .search-control:focus-within { border-color: #474747; box-shadow: 0 0 0 1px rgb(139 124 246 / 18%); }
  .demo-menu { position: relative; margin-left: auto; }
  .demo-menu > summary { display: flex; align-items: center; padding: 0 11px; cursor: pointer; list-style: none; }
  .demo-actions { position: absolute; z-index: 12; top: calc(100% + 6px); right: 0; display: grid; width: 160px; padding: 5px; border: 1px solid var(--border); border-radius: 7px; background: #111; box-shadow: 0 16px 48px rgb(0 0 0 / 55%); }
  .demo-actions button { border: 0; border-radius: 4px; background: transparent; padding: 8px; color: #aaa; text-align: left; font-size: 10px; }
  .demo-actions button:hover { background: #1a1a1a; color: #eee; }

  .columns { grid-template-columns: repeat(4, minmax(215px, 1fr)); gap: 10px; align-items: stretch; overflow-x: auto; padding-bottom: 6px; }
  .column { min-height: calc(100vh - 205px); background: #0b0c0c; padding: 11px; }
  .column h2 { margin: 1px 2px 13px; color: #ddd; font-size: 11px; font-weight: 560; letter-spacing: 0; text-transform: none; }
  .column h2::after { content: "•••"; margin-left: auto; color: #5f5f5f; letter-spacing: 2px; }
  .count { order: -1; margin-right: 7px; border: 0; background: #222; color: #888; }
  .card { min-height: 108px; margin-bottom: 8px; padding: 14px; background: #0e1010; }
  .card:hover { border-color: #454545; background: #121414; }
  .card-title { min-height: 35px; color: #ececec; font-size: 12px; font-weight: 570; }
  .card-meta { align-items: center; margin-top: 12px; color: #767676; }
  .chip { background: #0b0c0c; }
  .card-meta::after { content: "Open details"; margin-left: auto; color: #555; }

  /* Right-side task details */
  dialog { position: fixed; top: 70px; right: 14px; bottom: 14px; left: auto; width: 390px; max-height: none; margin: 0; border-radius: 7px; }
  dialog::backdrop { display: none; }
  .has-task-inspector[data-page="board"] .columns { margin-right: 402px; }
  .detail-header { padding: 17px 18px; }
  .detail-body { overflow-y: auto; max-height: calc(100vh - 145px); }

  /* History */
  .history-layout, .task-type-layout, .ontology-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 370px; gap: 14px; align-items: stretch; }
  .history-table, .side-inspector, .task-panel { min-width: 0; border: 1px solid var(--border); border-radius: 7px; background: #0b0d0d; overflow: hidden; }
  .history-table-head, .history-row { display: grid; grid-template-columns: 86px minmax(210px, 1.4fr) 92px 120px minmax(190px, 1.2fr) 135px; align-items: center; gap: 14px; }
  .history-table-head { min-height: 42px; padding: 0 14px; border-bottom: 1px solid var(--border); color: #767676; font-size: 9px; }
  .history-group { display: flex; align-items: center; min-height: 34px; padding: 0 15px; border-bottom: 1px solid #1d1d1d; color: #dedede; font-size: 10px; font-weight: 610; }
  .history-row { width: 100%; min-height: 43px; border: 0; border-bottom: 1px solid #1e1e1e; background: transparent; padding: 0 14px; color: #b8b8b8; text-align: left; cursor: pointer; font-size: 10px; }
  .history-row:hover { background: #101212; }
  .history-row.selected { box-shadow: inset 0 0 0 1px var(--accent); background: rgb(139 124 246 / 4%); }
  .history-time, .history-muted { min-width: 0; overflow: hidden; color: #8a8a8a; text-overflow: ellipsis; white-space: nowrap; }
  .history-event-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .history-event-cell strong { overflow: hidden; color: #d4d4d4; font-weight: 540; text-overflow: ellipsis; white-space: nowrap; }
  .event-dot { flex: 0 0 auto; width: 8px; height: 8px; border: 1.5px solid var(--accent); border-radius: 50%; }
  .event-dot.success { border-color: var(--success); }
  .event-dot.danger { border-color: var(--danger); }
  .history-chip { justify-self: start; border: 1px solid #2b2b2b; border-radius: 4px; padding: 3px 6px; color: #aaa; }
  .history-confidence { color: #a597ff; }
  .side-inspector { max-height: calc(100vh - 182px); overflow-y: auto; background: #0c0e0e; }
  .inspector-heading { display: grid; gap: 8px; padding: 17px 18px; border-bottom: 1px solid var(--border); color: #eee; font-size: 13px; font-weight: 590; }
  .event-state { color: #a597ff; font-size: 10px; font-weight: 500; }
  .history-inspector > .ontology-detail-grid { grid-template-columns: 1fr; padding: 8px 18px 0; }
  .history-inspector > .ontology-inspector-section { margin: 0; padding: 15px 18px; border-top: 1px solid var(--border); }
  .inspector-payload { overflow: auto; margin: 0; color: #898989; font: 9px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
  .inspector-empty { margin: auto; padding: 28px; color: #666; font-size: 10px; line-height: 1.6; text-align: center; }

  /* Task types */
  .task-type-filters .search-control { width: 360px; }
  .task-type-layout { grid-template-columns: minmax(0, 1fr) 405px; }
  .type-table-head, .type-row { display: grid; grid-template-columns: minmax(300px, 1fr) 95px 95px 65px; align-items: center; gap: 16px; }
  .type-table-head { min-height: 42px; padding: 0 15px; border-bottom: 1px solid var(--border); color: #777; font-size: 9px; }
  .type-row { width: 100%; min-height: 82px; border: 0; border-bottom: 1px solid var(--border); background: transparent; padding: 10px 15px; color: inherit; text-align: left; cursor: pointer; }
  .type-row:hover { background: #101212; }
  .type-row.selected { box-shadow: inset 0 0 0 1px var(--accent); background: rgb(139 124 246 / 4%); }
  .type-copy { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 13px; }
  .type-icon { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid #2b2b2b; border-radius: 7px; color: #bbb; font-size: 20px; }
  .type-copy-text { min-width: 0; }
  .type-name { color: #eee; font-family: inherit; font-size: 11px; font-weight: 580; }
  .type-description { overflow: hidden; margin-top: 5px; color: #777; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .enabled-state { color: #8d8d8d; font-size: 9px; font-weight: 500; }
  .enabled-state::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--success); vertical-align: middle; }
  .type-metric { color: #a2a2a2; font-size: 10px; }
  .type-steps { text-align: right; }
  .panel-footer { min-height: 40px; padding: 13px 15px; color: #666; }
  .task-type-inspector { max-height: calc(100vh - 195px); }
  .task-type-heading { display: flex; align-items: center; justify-content: space-between; }
  .inspector-title-row { display: flex; align-items: center; gap: 12px; }
  .inspector-title-row .type-icon { width: 40px; height: 40px; font-size: 17px; }
  .inspector-section { padding: 14px 15px 0; }
  .inspector-section > h3 { margin: 0 0 9px; color: #858585; font-size: 9px; font-weight: 560; }
  .trigger-card, .workflow-step, .configuration-row { border: 1px solid #252525; background: #0e1010; }
  .trigger-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 9px; min-height: 39px; border-radius: 6px; padding: 0 11px; color: #bbb; font-size: 10px; }
  .trigger-icon { color: #a697ff; }
  .workflow-step-list { display: grid; gap: 5px; }
  .workflow-step { display: grid; grid-template-columns: 14px 25px 1fr auto; align-items: center; gap: 7px; min-height: 46px; border-radius: 6px; padding: 0 9px; }
  .step-handle, .step-arrow { color: #565656; }
  .step-number { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid #303030; border-radius: 50%; color: #aaa; font-size: 9px; }
  .step-copy { color: #ccc; font-size: 10px; line-height: 1.35; }
  .configuration-list { padding-bottom: 12px; }
  .configuration-row { display: flex; justify-content: space-between; min-height: 38px; margin-top: -1px; padding: 11px; color: #777; font-size: 9px; }
  .configuration-row strong { max-width: 58%; color: #bbb; font-weight: 520; text-align: right; overflow-wrap: anywhere; }
  .inspector-actions, .ontology-inspector-actions { position: sticky; bottom: 0; display: flex; gap: 8px; padding: 12px 15px; border-top: 1px solid var(--border); background: rgb(12 14 14 / 94%); backdrop-filter: blur(12px); }
  .inspector-actions button { flex: 1; }

  /* Ontology graph explorer */
  body[data-page="ontology"] .app-header { margin-bottom: 14px; }
  .ontology-toolbar { display: grid; gap: 6px; margin-bottom: 10px; }
  .ontology-toolbar-meta { display: flex; align-items: center; justify-content: space-between; min-height: 32px; }
  .repository-button { display: flex; align-items: center; width: auto; min-width: 200px; max-width: min(420px, 44vw); height: 32px; min-height: 32px; border-color: transparent; background: transparent; padding: 0 8px; color: #999; line-height: 1; text-align: left; }
  .repository-button::after { content: "⌄"; margin-left: auto; color: #5f5f5f; }
  .repository-button:hover { border-color: transparent; background: #111; }
  .ontology-search-hero { display: grid; justify-items: center; padding: 0 16px 2px; }
  .context-search-shell { position: relative; z-index: 30; width: min(680px, 100%); height: 44px; margin: 0 auto; text-align: left; }
  .context-search { display: flex; align-items: center; width: 100%; height: 44px; min-height: 44px; box-sizing: border-box; border: 1px solid #303136; border-radius: 7px; background: #101114; padding: 0 8px; overflow: visible; transition: border-color 120ms ease, background 120ms ease; }
  .context-search:hover { border-color: #3b3c42; background: #121317; }
  .context-search:focus-within { border-color: #5f568f; background: #121317; box-shadow: 0 0 0 2px rgb(139 124 246 / 8%); }
  .context-search-icon { position: relative; display: block; flex: 0 0 28px; width: 15px; height: 15px; margin-left: 2px; font-size: 0; }
  .context-search-icon::before { content: ""; position: absolute; top: 1px; left: 1px; width: 8px; height: 8px; border: 1.25px solid #777; border-radius: 50%; }
  .context-search-icon::after { content: ""; position: absolute; top: 10px; left: 10px; width: 5px; height: 1.25px; border-radius: 999px; background: #777; transform: rotate(45deg); transform-origin: left center; }
  .context-search input { flex: 1; height: 42px; min-width: 0; border: 0; background: transparent; padding: 0 8px 0 2px; color: var(--text); font-size: 11px; line-height: 42px; outline: 0; }
  .context-search input::placeholder { color: #747474; }
  .context-search input:focus { box-shadow: none; }
  .context-search-clear, .context-search-submit { flex: 0 0 auto; width: 26px; height: 30px; border: 0; background: transparent; padding: 0; color: #696969; cursor: pointer; }
  .context-search-clear { display: none; font-size: 14px; }
  .context-search-shell.has-query .context-search-clear { display: block; }
  .context-search-submit { margin-left: 2px; border-left: 1px solid #28292d; color: #888; font-size: 13px; }
  .context-search-submit:hover, .context-search-clear:hover { color: #ddd; }
  .context-search-submit:disabled { color: #4b4b4b; cursor: wait; }
  .context-search-results { position: absolute; z-index: 40; top: calc(100% + 9px); left: 50%; width: min(900px, calc(100vw - 48px)); max-height: min(520px, 62vh); overflow-y: auto; overscroll-behavior: contain; border: 1px solid #303136; border-radius: 8px; background: #101114; padding: 0; box-shadow: 0 18px 60px rgb(0 0 0 / 68%); transform: translateX(-50%); }
  .context-search-results[hidden] { display: none; }
  .context-result-primary { display: grid; gap: 10px; padding: 15px 17px 14px; }
  .context-result-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .context-result-spark { color: #988af5; font-size: 13px; }
  .context-result-heading strong { min-width: 0; overflow: hidden; color: #e8e8e8; font-size: 11px; font-weight: 610; text-overflow: ellipsis; white-space: nowrap; }
  .context-result-confidence { margin-left: auto; color: #9a8ef0; font-size: 9px; white-space: nowrap; }
  .context-result-answer { margin: 0; color: #b9b9bc; font-size: 10px; line-height: 1.5; }
  .context-causal-trace { display: flex; align-items: center; gap: 9px; min-width: 0; color: #b9b9bc; font-size: 9px; }
  .context-causal-step { display: inline-flex; align-items: center; min-width: 0; }
  .context-causal-step::before { content: ""; flex: 0 0 auto; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #8b7cf6; }
  .context-causal-arrow { flex: 1 1 34px; max-width: 70px; height: 1px; background: #3a3a40; }
  .context-result-resolution { margin: 0; color: #858589; font-size: 9px; }
  .context-result-footer { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .context-citation-chip { max-width: 220px; overflow: hidden; border: 1px solid #303136; border-radius: 4px; background: #121317; padding: 5px 7px; color: #9a9a9d; font: 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .context-graph-match-count { margin-left: auto; color: #77777c; font-size: 9px; white-space: nowrap; }
  .context-full-evidence { border-top: 1px solid #25262a; }
  .context-full-evidence > summary { padding: 9px 17px; color: #747478; cursor: pointer; font-size: 9px; list-style: none; }
  .context-full-evidence > summary::-webkit-details-marker { display: none; }
  .context-full-evidence[open] > summary { border-bottom: 1px solid #25262a; }
  .context-full-evidence-body { display: grid; gap: 8px; padding: 12px 17px 16px; }
  .ontology-workspace { grid-template-columns: minmax(0, 1fr) 365px; gap: 10px; }
  .ontology-card { min-width: 0; border-radius: 7px; }
  .ontology-toolbar-meta > .graph-controls { position: relative; z-index: 8; display: flex; align-items: center; min-height: 32px; border: 0; background: transparent; padding: 0; }
  .graph-control-toolbar { display: flex; align-items: center; gap: 2px; min-height: 32px; }
  .graph-filter-menu { position: relative; height: 32px; margin: 0; }
  .graph-filter-menu > summary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 32px; box-sizing: border-box; border-color: transparent; background: transparent; padding: 0 9px; cursor: pointer; line-height: 1; list-style: none; }
  .graph-filter-menu > summary::-webkit-details-marker { display: none; }
  .graph-filter-menu > summary::before { content: ""; width: 6px; height: 6px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: translateY(-1px) rotate(45deg); }
  .graph-filter-popover { position: absolute; z-index: 20; top: calc(100% + 7px); left: 0; width: 410px; padding: 12px; border: 1px solid #303030; border-radius: 7px; background: #101111; box-shadow: 0 18px 60px rgb(0 0 0 / 65%); }
  .graph-filter-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .graph-filter-row { display: block; }
  .graph-filter-label { display: block; margin-bottom: 8px; color: #898989; font-size: 9px; text-transform: none; }
  .graph-filter-list { display: grid; grid-template-columns: 1fr; gap: 3px; }
  .graph-filter-chip { border: 0; background: transparent; padding: 5px 6px; text-align: left; }
  .graph-filter-chip:hover { background: #191919; }
  .graph-popover-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .graph-control-button, .graph-reset, .graph-zoom { display: inline-flex; align-items: center; justify-content: center; height: 32px; min-height: 32px; box-sizing: border-box; margin: 0; border-color: transparent; background: transparent; color: #777; line-height: 1; }
  .graph-control-button { padding: 0 9px; cursor: pointer; }
  .graph-control-button:hover, .graph-control-toolbar > .graph-reset:hover { border-color: transparent; background: #141414; color: #c7c7c7; }
  .graph-reset { padding: 0 9px; }
  .graph-control-toolbar > .graph-reset { font-size: 10px; }
  .graph-zoom-group { display: inline-flex; align-items: center; height: 32px; margin-left: 5px; border-left: 1px solid #242424; padding-left: 5px; }
  .graph-control-button[aria-label="Zoom out"], .graph-control-button[aria-label="Zoom in"] { width: 30px; padding: 0; font-size: 13px; }
  .graph-zoom { min-width: 48px; padding: 0 5px; font-variant-numeric: tabular-nums; }
  .ontology-toolbar-meta > .repository-button,
  .graph-control-toolbar > .graph-filter-menu,
  .graph-control-toolbar > .graph-filter-menu > summary,
  .graph-control-toolbar > .graph-reset,
  .graph-control-toolbar > .graph-control-button {
    box-sizing: border-box;
    block-size: 32px;
    min-block-size: 32px;
    max-block-size: 32px;
  }
  .graph-wrap { position: relative; height: calc(100vh - 164px); min-height: 560px; overflow: hidden; background-color: #090a0a; background-image: radial-gradient(circle, #202222 1px, transparent 1px); background-size: 24px 24px; }
  #ontology-graph { position: absolute; inset: 0; min-width: 0; height: 100%; overflow: hidden; touch-action: none; }
  #ontology-graph canvas { position: absolute; inset: 0; display: block; }
  .ontology-label-layer { position: absolute; z-index: 4; inset: 0; overflow: hidden; pointer-events: none; }
  .cosmos-node-label, .cosmos-edge-label { position: absolute; top: 0; left: 0; pointer-events: auto; }
  .cosmos-node-label { display: grid; gap: 2px; max-width: 260px; border: 1px solid #2d3030; border-radius: 6px; background: rgb(12 14 14 / 88%); padding: 6px 8px; color: #e8e8e8; font: inherit; text-align: left; box-shadow: 0 6px 22px rgb(0 0 0 / 35%); backdrop-filter: blur(8px); transform-origin: 0 50%; translate: 11px -50%; }
  .cosmos-node-label:hover, .cosmos-node-label.selected { border-color: #8b7cf6; background: rgb(18 18 21 / 96%); }
  .cosmos-node-label span { overflow: hidden; font-size: 10px; font-weight: 570; text-overflow: ellipsis; white-space: nowrap; }
  .cosmos-node-label small { color: #777; font-size: 8px; }
  .cosmos-edge-label { border: 1px solid #39343f; border-radius: 999px; background: rgb(15 14 17 / 92%); padding: 4px 7px; color: #a89cc3; font: 550 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .02em; translate: -50% -50%; cursor: grab; backdrop-filter: blur(8px); }
  .cosmos-edge-label:hover, .cosmos-edge-label.selected { border-color: #8b7cf6; color: #eeeaff; }
  .cosmos-edge-label:active { cursor: grabbing; }
  .ontology-minimap { position: absolute; z-index: 5; right: 12px; bottom: 12px; width: 142px; height: 92px; border: 1px solid #292b2b; border-radius: 6px; background: rgb(8 9 9 / 82%); pointer-events: none; backdrop-filter: blur(8px); }
  .graph-runtime-status { position: absolute; z-index: 5; top: 12px; right: 12px; display: flex; align-items: center; gap: 6px; border: 1px solid #252727; border-radius: 999px; background: rgb(8 9 9 / 78%); padding: 5px 8px; color: #727575; font-size: 8px; pointer-events: none; backdrop-filter: blur(8px); }
  .graph-runtime-status::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #53c78f; }
  .graph-runtime-status.active::before { animation: graph-pulse 1.2s ease-in-out infinite; }
  @keyframes graph-pulse { 50% { opacity: .25; transform: scale(.75); } }
  .graph-empty-state { position: absolute; z-index: 3; inset: 0; display: grid; place-items: center; color: #666; font-size: 10px; pointer-events: none; }
  .graph-empty-state[hidden] { display: none; }
  .ontology-summary { position: absolute; right: 12px; bottom: 12px; left: 12px; display: flex; gap: 6px; pointer-events: none; }
  .ontology-summary[hidden] { display: none; }
  .ontology-stat { flex: 0 1 145px; border-color: #222; background: rgb(10 11 11 / 82%); padding: 7px 9px; backdrop-filter: blur(10px); }
  .ontology-stat strong { margin-top: 3px; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .plane-key { position: absolute; z-index: 5; bottom: 69px; left: 12px; padding: 8px 10px; border: 1px solid #222; border-radius: 5px; background: rgb(10 11 11 / 84%); backdrop-filter: blur(10px); pointer-events: none; }
  .ontology-details { max-height: calc(100vh - 91px); padding: 0; border-top: 1px solid var(--border); background: #0c0e0e; }
  .ontology-workspace:not(.has-selection) { grid-template-columns: minmax(0, 1fr); }
  .ontology-workspace:not(.has-selection) .ontology-details { display: none; }
  .ontology-details > .empty-detail { padding: 30px 22px; text-align: center; }
  .ontology-item { min-height: 100%; border: 0; border-radius: 0; background: transparent; padding: 0; }
  .ontology-item-heading { position: sticky; top: 0; z-index: 3; align-items: flex-start; padding: 17px 17px; border-bottom: 1px solid var(--border); background: rgb(12 14 14 / 96%); }
  .ontology-heading-copy { display: grid; gap: 7px; min-width: 0; }
  .ontology-item-heading strong { color: #f0f0f0; font-size: 14px; line-height: 1.35; }
  .ontology-item-type { justify-self: start; border: 0; padding: 0; color: #777; font-size: 9px; }
  .inspector-close { width: 28px; height: 28px; border: 0; background: transparent; color: #8a8a8a; cursor: pointer; font-size: 18px; }
  .ontology-detail-grid { grid-template-columns: 1fr; gap: 0; margin: 0; padding: 10px 17px; }
  .ontology-detail-field { display: grid; grid-template-columns: 110px minmax(0, 1fr); align-items: start; min-height: 34px; border: 0; border-radius: 0; background: transparent; padding: 8px 0; }
  .ontology-detail-field .label { margin: 0; text-transform: none; }
  .ontology-detail-field .value { color: #bbb; font-size: 9px; overflow-wrap: anywhere; }
  .ontology-inspector-section { margin: 0; padding: 14px 17px; border-top: 1px solid var(--border); }
  .ontology-inspector-section h3 { color: #aaa; font-size: 9px; letter-spacing: 0; text-transform: none; }
  .ontology-confidence { border: 0; background: transparent; padding: 0; }
  .ontology-confidence-top .label { color: #777; font-size: 9px; text-transform: none; }
  .ontology-confidence-value { color: #a799ff; font-size: 17px; }
  .ontology-confidence-meter { height: 3px; }
  .ontology-evidence-list { display: grid; }
  .ontology-evidence { padding: 8px; line-height: 1.5; }
  .ontology-explanation { color: #aaa; font-size: 9px; }
  .ontology-relationship { padding: 9px; }
  .ontology-endpoint { position: relative; display: grid; gap: 5px; margin: 12px 17px 0; padding: 12px; border: 1px solid #262626; border-radius: 6px; background: #0e1010; }
  .ontology-endpoint strong { padding-right: 70px; color: #ddd; font-size: 10px; line-height: 1.45; }
  .ontology-endpoint .ontology-item-type { position: absolute; right: 12px; bottom: 12px; }
  .ontology-inspector-actions { flex-wrap: wrap; }
  .ontology-inspector-actions button { flex: 1 1 auto; min-height: 30px; }
  .context-search-results .context-results { margin: 0; }


  @media (max-width: 1100px) {
    .page-filters { overflow-x: auto; padding-bottom: 4px; }
    .page-filters > * { flex: 0 0 auto; }
    .history-layout, .task-type-layout, .ontology-workspace { grid-template-columns: minmax(0, 1fr); }
    .side-inspector, .ontology-details { max-height: none; }
    .history-table { overflow-x: auto; }
    .history-table-head, .history-row { min-width: 900px; }
    .task-type-inspector { max-height: none; }
    .ontology-details { min-height: 380px; }
  }
  @media (max-width: 700px) {
    .topbar { gap: 8px; }
    .brand-lockup { padding-right: 9px; }
    .brand-name { display: none; }
    .page-nav { gap: 0; }
    .page-nav a { padding: 0 7px; font-size: 10px; }
    #connection-text { display: none; }
    .page-heading { align-items: flex-start; margin-inline: 0; }
    .columns { grid-template-columns: repeat(4, 260px); }
    .has-task-inspector[data-page="board"] .columns { margin-right: 0; }
    dialog { top: 62px; right: 8px; bottom: 8px; left: 8px; width: auto; }
    .type-table-head { display: none; }
    .type-row { grid-template-columns: 1fr auto; }
    .type-row > .type-metric { display: none; }
    .type-row > .type-steps { display: block; }
    .graph-zoom { display: none; }
    .graph-filter-popover { width: min(410px, calc(100vw - 44px)); }
    .ontology-toolbar-meta { align-items: flex-start; flex-direction: column; gap: 5px; }
    .ontology-toolbar-meta > .graph-controls { align-self: stretch; overflow-x: auto; }
    .repository-button { min-width: 150px; }
    .ontology-search-hero { padding-inline: 0; }
    .context-search-shell { display: block; }
    .context-search-results { width: calc(100vw - 28px); }
    .context-causal-trace { align-items: flex-start; flex-direction: column; }
    .context-causal-arrow { width: 1px; height: 12px; margin-left: 3px; }
    .context-result-footer { flex-wrap: wrap; }
    .context-graph-match-count { width: 100%; margin-left: 0; }
  }
</style>
</head>
<body>
<main class="shell">
  <header class="app-header">
    <div class="topbar">
      <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">J</span><span class="brand-name">Jina</span></div>
      <nav class="page-nav" aria-label="Dashboard pages">
        <a href="/" data-page="board">Board</a>
        <a href="/history" data-page="history">History</a>
        <a href="/tasks" data-page="task-types">Task types</a>
        <a href="/ontology" data-page="ontology">Ontology</a>
      </nav>
      <div id="connection"><span class="pulse" id="connection-dot"></span><span id="connection-text">Connecting…</span></div>
    </div>
  </header>
  <section id="board-page">
    <header class="page-heading">
      <div><h1>Board</h1><p>Live operational work across repositories and workflows.</p></div>
    </header>
    <div class="page-filters" id="toolbar">
      <label class="search-control"><span aria-hidden="true">⌕</span><input id="board-search" placeholder="Search tasks…" aria-label="Search tasks"></label>
      <select id="board-repository" aria-label="Filter by repository"><option value="">Repository: All</option></select>
      <select id="board-owner" aria-label="Filter by owner"><option value="">Owner: All</option></select>
      <select id="board-type" aria-label="Filter by task type"><option value="">Task type: All</option></select>
      <select id="board-status" aria-label="Filter by status"><option value="">Status: All</option></select>
      <details class="demo-menu"><summary>Demo events</summary><div class="demo-actions"><button type="button" data-demo="pr">Open PR</button><button type="button" data-demo="issue">Open issue</button><button type="button" data-demo="push">Force-push PR #42</button></div></details>
    </div>
    <section class="columns" id="columns" aria-label="Task board"></section>
  </section>
  <section id="history-page" hidden>
    <header class="page-heading"><div><h1>History</h1><p>A complete record of task activity.</p></div></header>
    <div class="page-filters history-filters">
      <label class="search-control"><span aria-hidden="true">⌕</span><input id="history-search" placeholder="Search events…" aria-label="Search events"></label>
      <select id="history-event-type" aria-label="Filter by event type"><option value="">Event type: All</option></select>
      <select id="history-actor" aria-label="Filter by actor"><option value="">Actor: All</option></select>
      <select id="history-repository" aria-label="Filter by repository"><option value="">Repository: All</option></select>
      <select id="history-date" aria-label="Filter by date"><option value="">Date: All time</option><option value="today">Today</option><option value="week">Last 7 days</option></select>
    </div>
    <div class="history-layout">
      <section class="history-table" aria-label="Activity history"><div class="history-table-head"><span>Time</span><span>Event</span><span>Actor</span><span>Repository</span><span>Task</span><span>Evidence / confidence</span></div><div id="history-list"></div></section>
      <aside class="side-inspector history-inspector" id="history-details" aria-live="polite"></aside>
    </div>
  </section>
  <section id="task-types-page" hidden>
    <header class="page-heading"><div><h1>Task types</h1><p>Reusable workflows for recurring work.</p></div></header>
    <div class="page-filters task-type-filters"><label class="search-control"><span aria-hidden="true">⌕</span><input id="task-type-search" placeholder="Search task types…" aria-label="Search task types"></label></div>
    <div class="task-type-layout">
      <section class="task-panel" aria-labelledby="task-types-heading">
        <header class="type-table-head"><span>Task type</span><span>Last run</span><span>Success rate</span><span>Steps</span></header>
        <div class="task-list" id="task-type-list" aria-label="Task type list"></div>
        <footer class="panel-footer"><span class="task-count" id="task-type-count"></span></footer>
      </section>
      <aside class="side-inspector task-type-inspector" id="task-type-details" aria-live="polite"></aside>
    </div>
    <section class="workflow-panel" aria-labelledby="workflow-trees-heading" hidden>
      <header class="task-panel-header"><h2 id="workflow-trees-heading">Workflow dependency trees</h2><span class="task-count" id="workflow-count"></span></header>
      <p class="workflow-help">Read top to bottom: completing a prerequisite unblocks the waiting task below it; task creation triggers are shown separately. Conditional connectors apply only when their condition is true, and aggregate tasks close after all required work completes.</p>
      <div class="workflow-grid" id="workflow-tree-list" aria-label="Task dependency trees"></div>
    </section>
  </section>
  <section id="ontology-page" hidden>
    <div class="ontology-shell">
      <header class="ontology-toolbar"><div class="ontology-toolbar-meta"><button type="button" class="repository-button" id="ontology-title">Repository graph</button><div class="graph-controls" id="graph-controls" aria-label="Graph visibility controls"></div></div><section class="ontology-search-hero"><div class="context-search-shell" id="context-search-shell"><form class="context-search" id="context-query"><span class="context-search-icon" aria-hidden="true">⌕</span><label class="sr-only" for="context-question">Search this repository with citations</label><input id="context-question" name="question" placeholder="Ask anything about this repository…" aria-label="Search this repository with citations" aria-controls="context-search-results" aria-expanded="false" autocomplete="off" required><button type="button" class="context-search-clear" id="context-search-clear" aria-label="Clear cited search">×</button><button type="submit" class="context-search-submit" id="context-search-submit" aria-label="Search with citations" title="Search with citations">↵</button></form><div class="context-search-results" id="context-search-results" hidden><section class="context-results" id="context-results" aria-live="polite"></section></div></div></section></header>
      <section class="ontology-workspace" id="ontology-workspace">
        <section class="ontology-card">
          <div class="graph-wrap"><div id="ontology-graph" role="application" aria-label="Repository ontology graph"><div class="ontology-label-layer" id="ontology-label-layer"></div></div><div class="graph-empty-state" id="ontology-graph-empty" hidden></div><canvas class="ontology-minimap" id="ontology-minimap" aria-label="Graph overview"></canvas><span class="graph-runtime-status" id="graph-runtime-status">Loading GPU renderer…</span><section class="ontology-summary" id="ontology-summary" hidden></section><div class="plane-key"><span>Code</span><span class="knowledge">Knowledge</span></div></div>
        </section>
        <aside class="ontology-details side-inspector" id="ontology-details" aria-live="polite"></aside>
      </section>
      <details class="assertion-review"><summary>Review proposed knowledge</summary><div class="assertion-review-toolbar"><select id="assertion-predicate-filter" aria-label="Filter assertions by predicate"><option value="">All predicates</option></select><select id="assertion-kind-filter" aria-label="Filter assertions by entity kind"><option value="">All entity kinds</option></select></div><section class="assertion-review-list" id="assertion-review-list" aria-live="polite"></section></details>
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

<script src="/assets/ontology-graph-client.js?v=freeform-1"></script>
<script>
const API = ${JSON.stringify(apiUrl)};
const API_LABEL = ${JSON.stringify(apiLabel)};
let boardState = { tasks: [], dependencies: [], publications: [] };
let boardEvents = [];
let taskTypes = [];
let ontologyState = { latest: null, assertions: [] };
let assertionState = [];
let ontologyViewState = {
  graphKey: null,
  selected: null,
  hiddenNodeKinds: new Set(),
  hiddenEdgePredicates: new Set(),
  filterMenuOpen: false,
  zoomPercent: 100,
  rendererLabelKey: null,
  rendererLabels: {}
};
let ontologyRenderer = null;
let ontologyRefreshSequence = 0;
let contextState = null;
let contextSearchOpen = false;
let contextSearchLoading = false;
let contextEvidenceExpanded = false;
let contextRequestSequence = 0;
let contextAbortController = null;
let selectedHistoryEventId = null;
let selectedTaskType = null;
let nextPr = 100;
let nextIssue = 200;

const columns = document.getElementById("columns");
const taskTypeList = document.getElementById("task-type-list");
const taskTypeDetails = document.getElementById("task-type-details");
const workflowTreeList = document.getElementById("workflow-tree-list");
const historyList = document.getElementById("history-list");
const historyDetails = document.getElementById("history-details");
const dialog = document.getElementById("task-dialog");
const detailTitle = document.getElementById("detail-title");
const detailEyebrow = document.getElementById("detail-eyebrow");
const detailBody = document.getElementById("detail-body");
const ontologyGraph = document.getElementById("ontology-graph");
const ontologyLabelLayer = document.getElementById("ontology-label-layer");
const ontologyMinimap = document.getElementById("ontology-minimap");
const ontologyGraphEmpty = document.getElementById("ontology-graph-empty");
const graphRuntimeStatus = document.getElementById("graph-runtime-status");
const ontologySummary = document.getElementById("ontology-summary");
const ontologyDetails = document.getElementById("ontology-details");
const ontologyWorkspace = document.getElementById("ontology-workspace");
const graphControls = document.getElementById("graph-controls");
const contextResults = document.getElementById("context-results");
const contextSearchShell = document.getElementById("context-search-shell");
const contextSearchResults = document.getElementById("context-search-results");
const contextQuestion = document.getElementById("context-question");
const contextSearchSubmit = document.getElementById("context-search-submit");
const assertionReviewList = document.getElementById("assertion-review-list");

async function refresh() {
  try {
    const showingTaskTypes = location.pathname === "/tasks";
    const showingOntology = location.pathname === "/ontology";
    const showingHistory = location.pathname === "/history";
    if (showingOntology) {
      const requestSequence = ++ontologyRefreshSequence;
      const response = await fetch(API + "/ontology");
      if (!response.ok) throw new Error("API request failed");
      const nextOntologyState = await response.json();
      let nextAssertions = [];
      if (nextOntologyState.latest?.repository) {
        const assertionResponse = await fetch(API + "/ontology/assertions?repository=" + encodeURIComponent(nextOntologyState.latest.repository));
        if (!assertionResponse.ok) throw new Error("Assertion review request failed");
        nextAssertions = (await assertionResponse.json()).assertions || [];
      }
      nextOntologyState.assertions = nextAssertions.filter(function(assertion) { return assertion.status === "proposed"; });
      if (requestSequence !== ontologyRefreshSequence || location.pathname !== "/ontology") return;
      ontologyState = nextOntologyState;
      assertionState = nextAssertions;
    } else if (showingTaskTypes) {
      const responses = await Promise.all([fetch(API + "/task-types"), fetch(API + "/board"), fetch(API + "/events")]);
      if (!responses.every(function(response) { return response.ok; })) throw new Error("API request failed");
      taskTypes = await responses[0].json();
      boardState = await responses[1].json();
      boardEvents = await responses[2].json();
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
    else if (showingHistory) renderHistory();
    else {
      const partition = partitionBoardTasks(boardState.tasks);
      populateBoardFilters(partition.current);
      renderColumns(filteredBoardTasks(partition.current));
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
  document.getElementById("board-page").hidden = showingTaskTypes || showingOntology || showingHistory;
  document.getElementById("history-page").hidden = !showingHistory;
  document.getElementById("task-types-page").hidden = !showingTaskTypes;
  document.getElementById("ontology-page").hidden = !showingOntology;
  document.body.dataset.page = showingOntology ? "ontology" : showingTaskTypes ? "task-types" : showingHistory ? "history" : "board";
  for (const link of document.querySelectorAll("[data-page]")) {
    link.classList.toggle("active", link.dataset.page === (showingOntology ? "ontology" : showingTaskTypes ? "task-types" : showingHistory ? "history" : "board"));
  }
}

function renderOntology() {
  ontologyWorkspace.classList.remove("has-selection");
  ontologySummary.replaceChildren();
  ontologyDetails.replaceChildren();
  graphControls.replaceChildren();
  renderAssertionReview();
  const graph = ontologyState.latest;
  const graphKey = graph ? ontologyGraphIdentity(graph) : null;
  if (graphKey !== ontologyViewState.graphKey) resetOntologyViewForGraph(graphKey);
  renderContextResults();
  if (!graph) {
    ontologyGraphEmpty.hidden = false;
    ontologyGraphEmpty.textContent = "Run an ontology build to create the first graph.";
    if (ontologyRenderer) ontologyRenderer.setData({ key: "empty", nodes: [], edges: [], labels: {} });
    ontologySummary.append(ontologyStat("Status", "No graph yet"));
    ontologyDetails.append(textElement("p", "empty-detail", "Run an ontology_build task to create the first graph."));
    if (ontologyRenderer) ontologyRenderer.setSearchMatches([]);
    return;
  }

  document.getElementById("ontology-title").textContent = graph.repository + " @ " + graph.ref;
  const visibleGraph = filterOntologyGraph(graph, ontologyViewState.hiddenNodeKinds, ontologyViewState.hiddenEdgePredicates);
  if (!selectionIsVisible(ontologyViewState.selected, visibleGraph)) ontologyViewState.selected = null;
  ontologyWorkspace.classList.toggle("has-selection", Boolean(ontologyViewState.selected));
  ontologySummary.append(
    ontologyStat("Repository", graph.repository),
    ontologyStat("Nodes", visibleCount(visibleGraph.nodes.length, graph.nodes.length)),
    ontologyStat("Edges", visibleCount(visibleGraph.edges.length, graph.edges.length)),
    ontologyStat("Commit", graph.commitSha.slice(0, 12)),
    ontologyStat("Generated", formatTime(graph.generatedAt)),
    ontologyStat("Executor", graph.generator.executor + " · " + graph.generator.model)
  );
  renderGraphControls(graph);
  ontologyGraphEmpty.hidden = Boolean(visibleGraph.nodes.length);
  ontologyGraphEmpty.textContent = "All node types are hidden. Use Filters to bring them back.";
  ensureOntologyRenderer();
  if (ontologyRenderer) {
    if (ontologyViewState.rendererLabelKey !== graphKey) {
      ontologyViewState.rendererLabelKey = graphKey;
      ontologyViewState.rendererLabels = friendlyNodeLabels(graph);
    }
    const rendererKey = graphKey + "|nodes:" + Array.from(ontologyViewState.hiddenNodeKinds).sort().join(",") + "|edges:" + Array.from(ontologyViewState.hiddenEdgePredicates).sort().join(",");
    ontologyRenderer.setData({ key: rendererKey, nodes: visibleGraph.nodes, edges: visibleGraph.edges, labels: ontologyViewState.rendererLabels });
    ontologyRenderer.setSelection(ontologyViewState.selected);
    ontologyRenderer.setSearchMatches(contextGraphMatches(contextState, visibleGraph));
  }
  renderOntologyInspector(graph, visibleGraph);
}

function ensureOntologyRenderer() {
  if (ontologyRenderer) return ontologyRenderer;
  if (!window.JinaOntologyGraph) {
    graphRuntimeStatus.textContent = "GPU renderer unavailable";
    graphRuntimeStatus.classList.remove("active");
    ontologyGraphEmpty.hidden = false;
    ontologyGraphEmpty.textContent = "The interactive graph could not start. Use Table view or reload this page.";
    return null;
  }
  ontologyRenderer = window.JinaOntologyGraph.create({
    container: ontologyGraph,
    labels: ontologyLabelLayer,
    minimap: ontologyMinimap,
    status: graphRuntimeStatus,
    onSelect: function(selection) {
      ontologyViewState.selected = selection;
      renderOntology();
    },
    onZoomChange: function(percent) {
      ontologyViewState.zoomPercent = percent;
      const zoom = document.getElementById("graph-zoom-percent");
      if (zoom) zoom.textContent = percent + "%";
    }
  });
  return ontologyRenderer;
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

function ontologyGraphIdentity(graph) {
  return [graph.id || "", graph.repository || "", graph.ref || "", graph.commitSha || "", graph.generatedAt || ""].join("|");
}

function resetOntologyViewForGraph(graphKey) {
  invalidateContextRequest();
  ontologyViewState.graphKey = graphKey;
  ontologyViewState.selected = null;
  ontologyViewState.filterMenuOpen = false;
  ontologyViewState.rendererLabelKey = null;
  ontologyViewState.rendererLabels = {};
  contextState = null;
  contextSearchOpen = false;
  contextEvidenceExpanded = false;
  if (contextQuestion) contextQuestion.value = "";
}

function invalidateContextRequest() {
  contextRequestSequence += 1;
  if (contextAbortController) contextAbortController.abort();
  contextAbortController = null;
  contextSearchLoading = false;
}

function mergePullRequestsForCommit(node, graph) {
  const pullRequests = [];
  const seen = new Set();
  for (const edge of graph.edges) {
    if (edge.target !== node.id || edge.predicate !== "MERGED_AS" || seen.has(edge.source)) continue;
    const pullRequest = graph.nodes.find(function(candidate) {
      return candidate.id === edge.source && candidate.kind === "PullRequest";
    });
    if (!pullRequest) continue;
    seen.add(edge.source);
    pullRequests.push(pullRequest);
  }
  return pullRequests;
}

function commitShaForNode(node) {
  const labelSha = String(node.label || "").match(/^[a-f0-9]{7,40}$/i);
  if (labelSha) return labelSha[0];
  const canonicalSha = String(node.description || "").match(/(?:^|:)sha:([a-f0-9]{7,40})(?:$|:)/i);
  return canonicalSha ? canonicalSha[1] : null;
}

function canonicalNodeContext(description) {
  const value = String(description || "");
  const repositoryEntity = value.match(/^repo:([^:]+):(path|moniker):(.+)$/);
  if (repositoryEntity) return repositoryEntity[1] + " · " + repositoryEntity[3];
  const url = value.match(/^url:(https?:\\/\\/.+)$/i);
  if (url) return url[1];
  return value;
}

function friendlyNodeLabel(node, graph) {
  if (node.kind === "Commit") {
    const pullRequests = mergePullRequestsForCommit(node, graph);
    if (pullRequests.length === 1) return "Merge commit · " + pullRequests[0].label;
    const sha = commitShaForNode(node);
    if (sha) return "Commit · " + sha.slice(0, 12);
  }
  const technicalLabel = /^(?:entity:|node[_:]|[a-f0-9]{12,40}$)/i.test(node.label);
  if (technicalLabel) {
    const context = canonicalNodeContext(node.description);
    const kind = String(node.kind).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
    if (context && context !== node.label) return kind + " · " + context;
  }
  return node.label;
}

function friendlyNodeLabels(graph) {
  const labels = {};
  const nodesById = new Map(graph.nodes.map(function(node) { return [node.id, node]; }));
  const pullRequestsByCommit = new Map();
  for (const edge of graph.edges) {
    if (edge.predicate !== "MERGED_AS") continue;
    const pullRequest = nodesById.get(edge.source);
    if (!pullRequest || pullRequest.kind !== "PullRequest") continue;
    if (!pullRequestsByCommit.has(edge.target)) pullRequestsByCommit.set(edge.target, []);
    pullRequestsByCommit.get(edge.target).push(pullRequest);
  }
  for (const node of graph.nodes) {
    const pullRequests = pullRequestsByCommit.get(node.id);
    if (node.kind === "Commit" && pullRequests?.length === 1) {
      labels[node.id] = "Merge commit · " + pullRequests[0].label;
      continue;
    }
    if (node.kind === "Commit") {
      const sha = commitShaForNode(node);
      if (sha) {
        labels[node.id] = "Commit · " + sha.slice(0, 12);
        continue;
      }
    }
    labels[node.id] = friendlyNodeLabel(node, graph);
  }
  return labels;
}

function contextGraphMatches(state, graph) {
  if (!state || state.error || !graph) return [];
  const identifiers = new Set();
  const observations = new Set();
  const paths = new Set();
  const pathRanges = new Map();
  const shas = new Set();
  const labels = new Set();
  const predicates = new Set();
  const normalized = function(value) { return String(value || "").trim().toLocaleLowerCase(); };
  const addIdentifier = function(value) { if (typeof value === "string" && value.trim()) identifiers.add(value.trim()); };
  const addPath = function(value) { if (typeof value === "string" && value.trim()) paths.add(value.trim()); };
  const addSha = function(value) { if (typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value.trim())) shas.add(value.trim().toLocaleLowerCase()); };
  const addCitation = function(citation) {
    if (!citation || typeof citation !== "object") return;
    addIdentifier(citation.id);
    if (citation.kind === "observation" && typeof citation.id === "string") observations.add(citation.id);
    addPath(citation.path);
    if (typeof citation.path === "string" && Number.isFinite(citation.startLine)) {
      if (!pathRanges.has(citation.path)) pathRanges.set(citation.path, []);
      pathRanges.get(citation.path).push({ start: citation.startLine, end: Number.isFinite(citation.endLine) ? citation.endLine : citation.startLine });
    }
    addSha(citation.commitSha);
  };
  const walk = function(value, key) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (/^(?:entityId|assertionId|assertionIds|observationId|observationIds)$/i.test(key || "")) addIdentifier(value);
      if (/^(?:path|oldPath)$/i.test(key || "")) addPath(value);
      if (/^(?:sha|commitSha|evidenceCommitSha)$/i.test(key || "")) addSha(value);
      if (/^(?:label|name|title|naturalKey)$/i.test(key || "")) labels.add(normalized(value));
      if (/^predicate$/i.test(key || "")) predicates.add(String(value).trim().toUpperCase());
      return;
    }
    for (const entry of Object.entries(value)) walk(entry[1], entry[0]);
  };
  for (const citation of state.citations || []) addCitation(citation);
  for (const claim of state.citedClaims || []) for (const citation of claim.citations || []) addCitation(citation);
  for (const call of state.calls || []) {
    for (const item of call.items || []) {
      walk(item.data, "data");
      for (const citation of item.citations || []) addCitation(citation);
    }
  }

  const observationList = Array.from(observations);
  const shaList = Array.from(shas);
  const labelList = Array.from(labels);

  const evidenceMatches = function(evidence) {
    return (Array.isArray(evidence) ? evidence : []).some(function(value) {
      const text = String(value);
      if (identifiers.has(text) || observationList.some(function(id) { return text === id || text === "observation:" + id; })) return true;
      const range = /^(.*):([0-9]+)(?:-([0-9]+))?$/.exec(text);
      if (!range || !pathRanges.has(range[1])) return false;
      const start = Number.parseInt(range[2], 10);
      const end = Number.parseInt(range[3] || range[2], 10);
      return pathRanges.get(range[1]).some(function(citation) { return start <= citation.end && end >= citation.start; });
    });
  };
  const nodeIds = new Set();
  for (const node of graph.nodes || []) {
    const nodeLabel = normalized(node.label);
    const description = normalized(node.description);
    const pathMatch = typeof node.path === "string" && paths.has(node.path) && (node.kind === "File" || node.kind === "Document");
    const shaMatch = shaList.some(function(sha) {
      return [node.id, node.label, node.description].some(function(value) {
        const candidate = normalized(value);
        return candidate.length >= 7 && (candidate.includes(sha) || sha.includes(candidate));
      });
    });
    const semanticMatch = labelList.some(function(label) {
      return label.length >= 4 && (nodeLabel === label || description === label || (label.length >= 8 && nodeLabel.includes(label)));
    });
    if (identifiers.has(node.id) || pathMatch || shaMatch || semanticMatch || evidenceMatches(node.evidence)) nodeIds.add(node.id);
  }

  const edgeIds = new Set();
  for (const edge of graph.edges || []) {
    const endpointsMatch = nodeIds.has(edge.source) && nodeIds.has(edge.target);
    const predicateMatch = predicates.has(String(edge.predicate).toUpperCase()) && (nodeIds.has(edge.source) || nodeIds.has(edge.target));
    if (identifiers.has(edge.id) || evidenceMatches(edge.evidence) || endpointsMatch || predicateMatch) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
  }
  return [
    ...Array.from(nodeIds, function(id) { return { kind: "node", id: id }; }),
    ...Array.from(edgeIds, function(id) { return { kind: "edge", id: id }; })
  ];
}

function friendlyNodeExplanation(node, graph) {
  if (node.kind === "Commit") {
    const pullRequests = mergePullRequestsForCommit(node, graph);
    if (pullRequests.length === 1) return "This commit records the merge of " + friendlyNodeLabel(pullRequests[0], graph) + ".";
    if (pullRequests.length > 1) return "Multiple pull requests claim this merge commit. Inspect the visible relationships before attributing it to a pull request.";
  }
  return node.description || "No explanation provided for this node.";
}

function visibleCount(visible, total) {
  return visible === total ? String(total) : visible + " / " + total;
}

function renderGraphControls(graph) {
  const nodeKinds = countGraphTypes(graph.nodes, "kind");
  const edgePredicates = countGraphTypes(graph.edges, "predicate");
  const toolbar = element("div", "graph-control-toolbar");
  const filters = element("details", "graph-filter-menu");
  filters.open = ontologyViewState.filterMenuOpen;
  filters.addEventListener("toggle", function() { ontologyViewState.filterMenuOpen = filters.open; });
  const filterSummary = textElement("summary", "graph-control-button", "Filters");
  const popover = element("div", "graph-filter-popover");
  const filterColumns = element("div", "graph-filter-columns");
  filterColumns.append(
    graphFilterRow("Node types", "node", nodeKinds, ontologyViewState.hiddenNodeKinds),
    graphFilterRow("Relationship types", "edge", edgePredicates, ontologyViewState.hiddenEdgePredicates)
  );
  popover.append(filterColumns);
  const showAll = textElement("button", "graph-reset", "Show all");
  showAll.type = "button";
  showAll.disabled = ontologyViewState.hiddenNodeKinds.size === 0 && ontologyViewState.hiddenEdgePredicates.size === 0;
  showAll.addEventListener("click", function() {
    ontologyViewState.hiddenNodeKinds.clear();
    ontologyViewState.hiddenEdgePredicates.clear();
    renderOntology();
  });
  const removeAll = textElement("button", "graph-reset", "Remove all");
  removeAll.type = "button";
  removeAll.disabled = nodeKinds.every(function(entry) { return ontologyViewState.hiddenNodeKinds.has(entry[0]); }) &&
    edgePredicates.every(function(entry) { return ontologyViewState.hiddenEdgePredicates.has(entry[0]); });
  removeAll.addEventListener("click", function() {
    for (const entry of nodeKinds) ontologyViewState.hiddenNodeKinds.add(entry[0]);
    for (const entry of edgePredicates) ontologyViewState.hiddenEdgePredicates.add(entry[0]);
    renderOntology();
  });
  const resetLayout = textElement("button", "graph-reset", "Reset");
  resetLayout.type = "button";
  resetLayout.addEventListener("click", function() {
    if (ontologyRenderer) ontologyRenderer.reset();
  });
  const popoverActions = element("div", "graph-popover-actions");
  popoverActions.append(showAll, removeAll, resetLayout);
  popover.append(popoverActions);
  filters.append(filterSummary, popover);
  const fit = textElement("button", "graph-control-button", "Fit");
  fit.type = "button";
  fit.addEventListener("click", function() { if (ontologyRenderer) ontologyRenderer.fit(); });
  const zoomOut = textElement("button", "graph-control-button", "−");
  zoomOut.type = "button";
  zoomOut.setAttribute("aria-label", "Zoom out");
  zoomOut.addEventListener("click", function() { if (ontologyRenderer) ontologyRenderer.zoomBy(0.78); });
  const zoomPercent = textElement("span", "graph-zoom", ontologyViewState.zoomPercent + "%");
  zoomPercent.id = "graph-zoom-percent";
  const zoomIn = textElement("button", "graph-control-button", "+");
  zoomIn.type = "button";
  zoomIn.setAttribute("aria-label", "Zoom in");
  zoomIn.addEventListener("click", function() { if (ontologyRenderer) ontologyRenderer.zoomBy(1.28); });
  const zoomGroup = element("div", "graph-zoom-group");
  zoomGroup.append(zoomOut, zoomPercent, zoomIn);
  toolbar.append(filters, resetLayout, fit, zoomGroup);
  graphControls.append(toolbar);
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

function renderOntologyInspector(graph, visibleGraph) {
  const selection = ontologyViewState.selected;
  if (!selection) {
    if ((ontologyState.assertions || []).length) {
      renderAssertionReviewQueue(ontologyState.assertions);
      return;
    }
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
    const friendlyLabel = friendlyNodeLabel(node, graph);
    const explanation = friendlyNodeExplanation(node, graph);
    const fields = [
      ["ID", node.id],
      ["Type", node.kind]
    ];
    if (friendlyLabel !== node.label) fields.push(["Stored label", node.label]);
    fields.push(["Path", node.path || "Not applicable"]);
    fields.push(["Visible relationships", String(relatedEdges.length)]);
    if (explanation !== node.description && node.description) fields.push(["Canonical key", node.description]);
    const item = ontologyInspectorItem(friendlyLabel, "Node · " + node.kind);
    item.append(ontologyDetailGrid(fields));
    const confidence = connectedConfidenceSummary(relatedEdges);
    item.append(ontologyConfidence(
      "Connected relationship confidence",
      confidence.value,
      confidence.scoredCount
        ? "Average of " + confidence.scoredCount + " scored visible relationship" + (confidence.scoredCount === 1 ? "" : "s") + ". Nodes do not carry a direct confidence score."
        : "No visible connected relationships provide confidence scores. Nodes do not carry a direct confidence score."
    ));
    item.append(ontologyEvidenceSection(node.evidence));
    item.append(ontologyExplanation(explanation));
    item.append(ontologyRelationshipSection(node, relatedEdges, graph));
    item.append(ontologyInspectorActions(["⌖  Pin", "◎  Center", "↗  Open source"]));
    ontologyDetails.append(item);
    return;
  }
  const edge = graph.edges.find(function(item) { return item.id === selection.id; });
  if (!edge) return;
  const source = graph.nodes.find(function(node) { return node.id === edge.source; });
  const target = graph.nodes.find(function(node) { return node.id === edge.target; });
  const sourceLabel = source ? friendlyNodeLabel(source, graph) : edge.source;
  const targetLabel = target ? friendlyNodeLabel(target, graph) : edge.target;
  const item = ontologyInspectorItem(edge.predicate, "Edge · " + edge.plane + " plane");
  item.append(ontologyEndpoint("Source (from)", sourceLabel, source?.kind || "Node"));
  item.append(ontologyEndpoint("Target (to)", targetLabel, target?.kind || "Node"));
  item.append(ontologyDetailGrid([["Relationship type", edge.plane], ["Predicate", edge.predicate], ["Relationship ID", edge.id]]));
  item.append(ontologyConfidence(
    "Relationship confidence",
    edge.confidence,
    edge.confidence === undefined ? "This relationship was stored without a confidence score." : "Direct confidence score stored on this relationship."
  ));
  item.append(ontologyEvidenceSection(edge.evidence));
  item.append(ontologyExplanation(edge.why || "This relationship states that " + sourceLabel + " " + humanize(edge.predicate) + " " + targetLabel + "."));
  item.append(ontologyInspectorActions(["⇄  Reverse direction", "⌁  Reconnect", "◌  Hide type", "⌫  Delete"]));
  ontologyDetails.append(item);
}

function renderAssertionReviewQueue(assertions) {
  ontologyWorkspace.classList.add("has-selection");
  const heading = element("div", "ontology-item-heading");
  const copy = element("div", "ontology-heading-copy");
  copy.append(textElement("strong", "", "Assertion review"), textElement("span", "ontology-item-type", assertions.length + " proposed"));
  heading.append(copy);
  const list = element("div", "assertion-review-list");
  assertions.forEach(function(assertion) {
    const card = element("article", "assertion-review-card");
    card.append(
      textElement("strong", "", assertion.subjectLabel + " · " + assertion.predicate + " · " + assertion.objectLabel),
      textElement("p", "", assertion.explanation || "This legacy assertion has no explanation and should not be accepted without review."),
      textElement("p", "", "Evidence: " + ((assertion.evidence || []).join(", ") || "none"))
    );
    const rejection = assertionRejectionFields();
    const actions = element("div", "assertion-review-actions");
    const accept = textElement("button", "secondary-button", "Accept");
    accept.type = "button";
    accept.addEventListener("click", function() { reviewAssertion(assertion.id, "accept"); });
    const reject = textElement("button", "danger-button", "Reject");
    reject.type = "button";
    reject.addEventListener("click", function() {
      if (!rejection.code.value || !rejection.reason.value.trim()) {
        rejection.reason.setCustomValidity("Choose a category and provide a reason.");
        rejection.reason.reportValidity();
        return;
      }
      rejection.reason.setCustomValidity("");
      reviewAssertion(assertion.id, "reject", rejection.code.value, rejection.reason.value.trim());
    });
    actions.append(accept, reject);
    card.append(rejection.fields, actions);
    list.append(card);
  });
  ontologyDetails.append(heading, list);
}

function assertionRejectionFields() {
  const fields = element("div", "assertion-review-fields");
  const code = document.createElement("select");
  code.className = "assertion-rejection-code";
  [
    ["", "Rejection category"],
    ["incorrect_relationship", "Incorrect relationship"],
    ["insufficient_evidence", "Insufficient evidence"],
    ["unsupported_explanation", "Unsupported explanation"],
    ["other", "Other"]
  ].forEach(function(entry) { const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; code.append(option); });
  const reason = document.createElement("input");
  reason.className = "assertion-rejection-reason";
  reason.placeholder = "Reason for rejection";
  fields.append(code, reason);
  return { fields: fields, code: code, reason: reason };
}

async function reviewAssertion(assertionId, decision, rejectionCode, reason) {
  const body = { type: "review_assertion", assertionId: assertionId, decision: decision };
  if (rejectionCode) body.rejectionCode = rejectionCode;
  if (reason) body.reason = reason;
  const response = await fetch(API + "/ontology/commands", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Assertion review failed");
  await refresh();
}

function ontologyInspectorItem(title, type) {
  const item = element("article", "ontology-item");
  const heading = element("div", "ontology-item-heading");
  const copy = element("div", "ontology-heading-copy");
  copy.append(textElement("strong", "", title), textElement("span", "ontology-item-type", type));
  const close = textElement("button", "inspector-close", "×");
  close.type = "button"; close.setAttribute("aria-label", "Clear graph selection");
  close.addEventListener("click", function() { ontologyViewState.selected = null; renderOntology(); });
  heading.append(copy, close);
  item.append(heading);
  return item;
}

function ontologyEndpoint(label, value, kind) {
  const section = element("section", "ontology-endpoint");
  section.append(textElement("span", "label", label), textElement("strong", "", value), textElement("span", "ontology-item-type", humanize(kind)));
  return section;
}

function ontologyInspectorActions(labels) {
  const actions = element("footer", "ontology-inspector-actions");
  labels.forEach(function(label) {
    const button = textElement("button", /Delete/.test(label) ? "danger-button" : "secondary-button", label);
    button.type = "button";
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    button.title = "This action is not available in the read-only graph explorer.";
    actions.append(button);
  });
  return actions;
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

function ontologyExplanation(value) {
  const section = element("section", "ontology-inspector-section");
  section.append(textElement("h3", "", "Explanation"), textElement("p", "ontology-explanation", value));
  return section;
}

function connectedConfidenceSummary(edges) {
  const scores = edges.map(function(edge) { return edge.confidence; }).filter(function(value) {
    return typeof value === "number" && Number.isFinite(value);
  });
  return {
    value: scores.length ? scores.reduce(function(total, value) { return total + value; }, 0) / scores.length : undefined,
    scoredCount: scores.length,
    totalCount: edges.length
  };
}

function ontologyConfidence(label, value, note) {
  const section = element("section", "ontology-inspector-section");
  section.append(textElement("h3", "", "Confidence"));
  const card = element("div", "ontology-confidence");
  const top = element("div", "ontology-confidence-top");
  top.append(textElement("span", "label", label), textElement("strong", "ontology-confidence-value", confidenceLabel(value)));
  card.append(top);
  if (typeof value === "number" && Number.isFinite(value)) {
    const meter = element("div", "ontology-confidence-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", label);
    meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(Math.round(clampConfidence(value) * 100)));
    const fill = element("span", "ontology-confidence-fill");
    fill.style.width = Math.round(clampConfidence(value) * 100) + "%";
    meter.append(fill);
    card.append(meter);
  }
  card.append(textElement("p", "ontology-confidence-note", note));
  section.append(card);
  return section;
}

function confidenceLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not provided";
  const confidence = clampConfidence(value);
  return Math.round(confidence * 100) + "% · " + confidence.toFixed(2);
}

function clampConfidence(value) { return Math.max(0, Math.min(1, value)); }

function ontologyEvidenceSection(evidence) {
  const citations = Array.isArray(evidence) ? evidence : [];
  const section = element("section", "ontology-inspector-section");
  section.append(textElement("h3", "", "Evidence · " + citations.length));
  if (!citations.length) {
    section.append(textElement("p", "empty-detail", "No evidence citations were provided."));
    return section;
  }
  const list = element("ul", "ontology-evidence-list");
  for (const citation of citations) list.append(textElement("li", "ontology-evidence", citation));
  section.append(list);
  return section;
}

function ontologyRelationshipSection(node, edges, graph) {
  const section = element("section", "ontology-inspector-section");
  section.append(textElement("h3", "", "Visible relationships · " + edges.length));
  if (!edges.length) {
    section.append(textElement("p", "empty-detail", "No visible relationships connect to this node."));
    return section;
  }
  const list = element("div", "ontology-relationship-list");
  for (const edge of edges) {
    const outgoing = edge.source === node.id;
    const otherId = outgoing ? edge.target : edge.source;
    const other = graph.nodes.find(function(candidate) { return candidate.id === otherId; });
    const button = element("button", "ontology-relationship");
    button.type = "button";
    button.append(
      textElement("span", "ontology-relationship-title", (outgoing ? "Outgoing · " : "Incoming · ") + edge.predicate + " · " + (other ? friendlyNodeLabel(other, graph) : otherId)),
      textElement("span", "ontology-relationship-meta", edge.plane + " · " + confidenceLabel(edge.confidence)),
      textElement("span", "ontology-relationship-explanation", edge.why || "No relationship explanation provided. Select for full details.")
    );
    button.addEventListener("click", function() {
      ontologyViewState.selected = { kind: "edge", id: edge.id };
      renderOntology();
    });
    list.append(button);
  }
  section.append(list);
  return section;
}

function renderContextResults() {
  const query = contextQuestion.value.trim();
  contextSearchShell.classList.toggle("has-query", Boolean(query));
  contextSearchSubmit.disabled = contextSearchLoading;
  contextSearchSubmit.textContent = contextSearchLoading ? "…" : "↵";
  contextSearchResults.hidden = !contextSearchOpen || (!contextState && !contextSearchLoading);
  contextQuestion.setAttribute("aria-expanded", String(!contextSearchResults.hidden));
  contextResults.replaceChildren();
  if (contextSearchLoading) {
    contextResults.append(textElement("p", "empty-detail", "Searching repository evidence…"));
    return;
  }
  if (!contextState) return;
  const graphMatches = contextGraphMatches(contextState, ontologyState.latest);
  if (contextState.error) {
    contextResults.append(textElement("p", "empty-detail", contextState.error));
    return;
  }
  contextResults.append(renderContextPrimary(contextState, graphMatches, ontologyState.latest));
  const evidence = element("details", "context-full-evidence");
  evidence.open = contextEvidenceExpanded;
  evidence.addEventListener("toggle", function() {
    contextEvidenceExpanded = evidence.open;
  });
  evidence.append(textElement("summary", "", "View full evidence"));
  const evidenceBody = element("div", "context-full-evidence-body");
  const notices = renderContextNotices(contextState);
  if (notices) evidenceBody.append(notices);
  if (contextState.answer) evidenceBody.append(renderContextAnswer(contextState));
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
      if (item.kind === "causal_trace" && item.data && item.data.root) {
        section.append(renderCausalTrace(item.data));
        continue;
      }
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
    evidenceBody.append(section);
  }
  if (!evidenceBody.childElementCount) evidenceBody.append(textElement("p", "empty-detail", "No additional evidence was returned."));
  evidence.append(evidenceBody);
  contextResults.append(evidence);
}

function contextIssueTraceItem(state) {
  for (const call of state.calls || []) {
    for (const item of call.items || []) {
      if (item.kind === "issue_trace" && item.data && item.data.issue) return item;
    }
  }
  return null;
}

function contextMatchConfidence(matches, graph) {
  if (!graph) return undefined;
  const edgeIds = new Set(matches.filter(function(match) { return match.kind === "edge"; }).map(function(match) { return match.id; }));
  const scores = (graph.edges || []).filter(function(edge) { return edgeIds.has(edge.id); }).map(function(edge) {
    return edge.confidence;
  }).filter(function(value) { return typeof value === "number" && Number.isFinite(value); });
  return scores.length ? scores.reduce(function(total, value) { return total + value; }, 0) / scores.length : undefined;
}

function contextPrimaryCitations(state, item, trace) {
  const citations = [];
  const seen = new Set();
  const push = function(label) {
    if (!label || seen.has(label) || citations.length >= 3) return;
    seen.add(label);
    citations.push(label);
  };
  const cause = trace && Array.isArray(trace.introducedBy) ? trace.introducedBy[0] : null;
  const resolution = trace && Array.isArray(trace.resolutions) ? trace.resolutions[0] : null;
  if (cause && cause.sha) push("commit " + cause.sha.slice(0, 12));
  if (cause && Array.isArray(cause.changes) && cause.changes[0]) push(cause.changes[0].path);
  if (resolution && resolution.pullRequestNumber) push("PR #" + resolution.pullRequestNumber);
  for (const label of citationLabels([...(item?.citations || []), ...(state.citations || [])])) push(label);
  return citations;
}

function contextDateLabel(value) {
  if (!value) return "First known change";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "First known change";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function contextPathLabel(path) {
  if (!path) return "Code changed";
  const parts = String(path).split("/");
  return parts[parts.length - 1] || path;
}

function renderContextPrimary(state, graphMatches, graph) {
  const item = contextIssueTraceItem(state);
  const trace = item?.data;
  const issue = trace?.issue;
  const cause = Array.isArray(trace?.introducedBy) ? trace.introducedBy[0] : null;
  const resolution = Array.isArray(trace?.resolutions) ? trace.resolutions[0] : null;
  const primary = element("article", "context-result-primary");
  const heading = element("div", "context-result-heading");
  const title = issue
    ? (issue.number ? "Issue #" + issue.number + (issue.title ? " · " + issue.title : "") : issue.title || issue.displayId || "Repository answer")
    : "Cited repository answer";
  const confidence = contextMatchConfidence(graphMatches, graph);
  heading.append(
    textElement("span", "context-result-spark", "✦"),
    textElement("strong", "", title),
    textElement("span", "context-result-confidence", confidence === undefined ? "Cited answer" : Math.round(clampConfidence(confidence) * 100) + "% confidence")
  );
  primary.append(heading, textElement("p", "context-result-answer", state.answer || "No cited answer was returned."));
  if (issue && cause) {
    const changes = Array.isArray(cause.changes) ? cause.changes : [];
    const traceRow = element("div", "context-causal-trace");
    traceRow.append(
      textElement("span", "context-causal-step", contextDateLabel(cause.committedAt) + (cause.sha ? " · " + cause.sha.slice(0, 8) : "")),
      textElement("span", "context-causal-arrow", ""),
      textElement("span", "context-causal-step", contextPathLabel(changes[0]?.path)),
      textElement("span", "context-causal-arrow", ""),
      textElement("span", "context-causal-step", "Issue #" + (issue.number || issue.displayId || "observed"))
    );
    primary.append(traceRow);
  }
  if (resolution) {
    const resolutionCommit = Array.isArray(resolution.commits) ? resolution.commits[0] : null;
    const resolutionText = "Resolved by PR #" + resolution.pullRequestNumber + (resolution.title ? " · " + resolution.title : "") +
      (resolutionCommit?.committedAt ? " · " + contextDateLabel(resolutionCommit.committedAt) : "");
    primary.append(textElement("p", "context-result-resolution", resolutionText));
  }
  const footer = element("footer", "context-result-footer");
  for (const citation of contextPrimaryCitations(state, item, trace)) footer.append(textElement("span", "context-citation-chip", citation));
  footer.append(textElement("span", "context-graph-match-count", graphMatches.length + (graphMatches.length === 1 ? " graph match" : " graph matches")));
  primary.append(footer);
  return primary;
}

function renderContextAnswer(state) {
  const answer = element("article", "context-answer");
  answer.append(
    textElement("span", "context-answer-label", "Answer"),
    textElement("p", "context-answer-text", state.answer)
  );
  if (state.counterfactual) answer.append(renderCounterfactualDetails(state.counterfactual));
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

function renderCounterfactualDetails(value) {
  const details = element("div", "context-claims");
  details.append(textElement("h4", "", "Basis: " + (value.basis || "graph-derived")));
  details.append(ontologyDetailGrid([
    ["Intervention", value.intervention ? value.intervention.kind + " · " + value.intervention.label : "Unresolved"],
    ["Outcome", value.outcome ? value.outcome.kind + " · " + value.outcome.label : "Unresolved"],
    ["Known paths removed", String((value.removedPaths || []).length)],
    ["Known paths remaining", String((value.remainingPaths || []).length)]
  ]));
  const why = (value.removedPaths || []).concat(value.remainingPaths || []).filter(function(path) { return path.why; });
  if (why.length) details.append(traceFact("Why", why.map(function(path) { return path.why; }).join(" · ")));
  const evidence = (value.removedPaths || []).concat(value.remainingPaths || []).flatMap(function(path) {
    return citationLabels(path.citations || []);
  });
  details.append(traceEvidence(Array.from(new Set(evidence))));
  return details;
}

function renderCausalTrace(trace) {
  const container = element("div", "issue-trace");
  container.append(textElement("strong", "", trace.root.kind + " · " + trace.root.label));
  const groups = [
    ["Causes", trace.causes], ["Resolutions", trace.resolutions], ["Implementations", trace.implementations],
    ["Affected entities", trace.affectedEntities], ["Dependencies", trace.dependencies], ["Deployments", trace.deployments],
    ["Documentation", trace.documentation], ["Ownership", trace.ownership], ["Moved from", trace.movedFrom]
  ];
  for (const group of groups) {
    if (!Array.isArray(group[1]) || !group[1].length) continue;
    const block = element("div", "trace-explanation");
    block.append(textElement("span", "trace-fact-label", group[0]));
    for (const path of group[1]) block.append(textElement("p", "trace-fact-value",
      path.nodes.map(function(node) { return node.label; }).join(" → ") + (path.why ? " — " + path.why : "")
    ));
    container.append(block);
  }
  return container;
}

function renderAssertionReview() {
  assertionReviewList.replaceChildren();
  const predicateFilter = document.getElementById("assertion-predicate-filter");
  const kindFilter = document.getElementById("assertion-kind-filter");
  const predicates = uniqueValues(assertionState.map(function(assertion) { return assertion.predicate; }));
  const kinds = uniqueValues(assertionState.flatMap(function(assertion) { return [assertion.subjectKind, assertion.objectKind]; }));
  populateAssertionFilter(predicateFilter, "All predicates", predicates);
  populateAssertionFilter(kindFilter, "All entity kinds", kinds);
  const visible = assertionState.filter(function(assertion) {
    return (!predicateFilter.value || assertion.predicate === predicateFilter.value) &&
      (!kindFilter.value || assertion.subjectKind === kindFilter.value || assertion.objectKind === kindFilter.value);
  });
  if (!visible.length) {
    assertionReviewList.append(textElement("p", "empty-detail", "No assertions match these filters."));
    return;
  }
  for (const assertion of visible) {
    const item = element("article", "assertion-review-item");
    const heading = element("header");
    heading.append(textElement("strong", "", assertion.subjectLabel + " " + assertion.predicate + " " + assertion.objectLabel),
      textElement("span", "enabled-state", assertion.status));
    item.append(heading,
      textElement("p", "", "Confidence " + confidenceLabel(assertion.confidence) + " · " + assertion.generator),
      traceEvidence(Array.isArray(assertion.evidence) ? assertion.evidence : []),
      textElement("p", "assertion-relations", "Supports: " + (assertion.supportingAssertionIds || []).join(", ") + " · Contradicts: " + (assertion.contradictingAssertionIds || []).join(", ") )
    );
    if (assertion.status === "proposed") item.append(assertionRejectionFields().fields);
    const actions = element("footer", "assertion-actions");
    for (const decision of assertion.status === "proposed" ? ["accept", "reject"] : assertion.status === "active" ? ["retract"] : []) {
      const button = textElement("button", decision === "accept" ? "primary-button" : "secondary-button", humanize(decision));
      button.type = "button";
      button.dataset.assertionId = assertion.id;
      button.dataset.assertionDecision = decision;
      actions.append(button);
    }
    item.append(actions);
    assertionReviewList.append(item);
  }
}

function populateAssertionFilter(select, label, values) {
  const current = select.value;
  select.replaceChildren();
  const all = textElement("option", "", label); all.value = ""; select.append(all);
  for (const value of values) { const option = textElement("option", "", humanize(value)); option.value = value; select.append(option); }
  select.value = values.includes(current) ? current : "";
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
  return /\\b(caus(?:e|ed|ation|al)|introduc(?:e|ed|ing)|root cause|first (?:start|begin|appear))\\b|when did[\\s\\S]{0,200}\\b(?:start|begin|appear)/i.test(String(question || ""));
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

function populateBoardFilters(tasks) {
  populateSelect("board-repository", "Repository: All", uniqueValues(tasks.map(function(task) { return task.metadata?.repository; })));
  populateSelect("board-owner", "Owner: All", uniqueValues(tasks.map(function(task) { return task.assigneeRole; })));
  populateSelect("board-type", "Task type: All", uniqueValues(tasks.map(function(task) { return task.type; })));
  populateSelect("board-status", "Status: All", uniqueValues(tasks.map(function(task) { return task.status; })));
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean).map(String))).sort(function(left, right) { return left.localeCompare(right); });
}

function populateSelect(id, allLabel, values) {
  const select = document.getElementById(id);
  const current = select.value;
  select.replaceChildren();
  const all = textElement("option", "", allLabel);
  all.value = "";
  select.append(all);
  for (const value of values) {
    const option = textElement("option", "", humanize(value));
    option.value = value;
    select.append(option);
  }
  select.value = values.includes(current) ? current : "";
}

function filteredBoardTasks(tasks) {
  const query = document.getElementById("board-search").value.trim().toLowerCase();
  const repository = document.getElementById("board-repository").value;
  const owner = document.getElementById("board-owner").value;
  const type = document.getElementById("board-type").value;
  const status = document.getElementById("board-status").value;
  return tasks.filter(function(task) {
    const haystack = [task.title, task.type, task.assigneeRole, task.metadata?.repository].filter(Boolean).join(" ").toLowerCase();
    return (!query || haystack.includes(query)) &&
      (!repository || task.metadata?.repository === repository) &&
      (!owner || task.assigneeRole === owner) &&
      (!type || task.type === type) &&
      (!status || task.status === status);
  });
}

function renderHistory() {
  populateHistoryFilters();
  const events = filteredHistoryEvents();
  historyList.replaceChildren();
  if (!events.some(function(event) { return event.id === selectedHistoryEventId; })) selectedHistoryEventId = events[0]?.id || null;
  if (!events.length) historyList.append(textElement("p", "empty", "No events match these filters."));
  let previousGroup = null;
  for (const event of events) {
    const group = historyDateGroup(event.at);
    if (group !== previousGroup) {
      const heading = textElement("div", "history-group", group);
      historyList.append(heading);
      previousGroup = group;
    }
    historyList.append(historyRow(event));
  }
  renderHistoryInspector(events.find(function(event) { return event.id === selectedHistoryEventId; }) || null);
}

function populateHistoryFilters() {
  populateSelect("history-event-type", "Event type: All", uniqueValues(boardEvents.map(function(event) { return event.type; })));
  populateSelect("history-actor", "Actor: All", uniqueValues(boardEvents.map(function(event) { return historyEventContext(event).actor; })));
  populateSelect("history-repository", "Repository: All", uniqueValues(boardEvents.map(function(event) { return historyEventContext(event).repository; })));
}

function filteredHistoryEvents() {
  const query = document.getElementById("history-search").value.trim().toLowerCase();
  const type = document.getElementById("history-event-type").value;
  const actor = document.getElementById("history-actor").value;
  const repository = document.getElementById("history-repository").value;
  const date = document.getElementById("history-date").value;
  const now = Date.now();
  return boardEvents.slice().reverse().filter(function(event) {
    const context = historyEventContext(event);
    const haystack = [eventLabel(event), context.task?.title, context.actor, context.repository, formatValue(event.payload || {})].filter(Boolean).join(" ").toLowerCase();
    const age = now - new Date(event.at).getTime();
    return (!query || haystack.includes(query)) && (!type || event.type === type) && (!actor || context.actor === actor) &&
      (!repository || context.repository === repository) && (!date || (date === "today" ? age <= 86400000 : age <= 604800000));
  });
}

function historyEventContext(event) {
  const task = event.taskId ? taskById(event.taskId) : null;
  return {
    task: task,
    actor: String(event.payload?.actor || event.payload?.assigneeRole || task?.assigneeRole || "System"),
    repository: String(event.payload?.repository || task?.metadata?.repository || "—")
  };
}

function historyDateGroup(value) {
  const date = new Date(value);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const eventStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (eventStart === start) return "Today";
  if (eventStart === start - 86400000) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function historyRow(event) {
  const context = historyEventContext(event);
  const confidence = historyEventConfidence(event);
  const row = element("button", "history-row" + (event.id === selectedHistoryEventId ? " selected" : ""));
  row.type = "button";
  row.dataset.historyEventId = event.id;
  row.append(
    textElement("time", "history-time", new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
    historyEventCell(event),
    textElement("span", "history-chip", humanize(context.actor)),
    textElement("span", "history-muted", context.repository),
    textElement("span", "history-muted", context.task?.title || "Board event"),
    textElement("span", confidence === undefined ? "history-muted" : "history-confidence", confidence === undefined ? "—" : confidenceLabel(confidence))
  );
  return row;
}

function historyEventCell(event) {
  const cell = element("span", "history-event-cell");
  const tone = /failed|canceled/i.test(event.type) ? " danger" : /completed|created/i.test(event.type) ? " success" : "";
  cell.append(textElement("span", "event-dot" + tone, ""), textElement("strong", "", eventLabel(event)));
  return cell;
}

function historyEventConfidence(event) {
  const value = event.payload?.confidence;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderHistoryInspector(event) {
  historyDetails.replaceChildren();
  if (!event) {
    historyDetails.append(textElement("p", "inspector-empty", "Select an event to inspect its provenance and changes."));
    return;
  }
  const context = historyEventContext(event);
  const heading = element("header", "inspector-heading");
  heading.append(textElement("div", "", eventLabel(event)), textElement("span", "event-state", humanize(event.type.split(".").pop())));
  historyDetails.append(heading);
  historyDetails.append(ontologyDetailGrid([
    ["Event ID", event.id], ["Timestamp", formatTime(event.at)], ["Actor", humanize(context.actor)],
    ["Repository", context.repository], ["Source task", context.task?.title || "Board event"], ["Sequence", String(event.seq)]
  ]));
  const confidence = historyEventConfidence(event);
  if (confidence !== undefined) historyDetails.append(ontologyConfidence("Recorded confidence", confidence, "Confidence supplied by the event producer."));
  const evidence = Array.isArray(event.payload?.evidence) ? event.payload.evidence : [];
  historyDetails.append(ontologyEvidenceSection(evidence));
  historyDetails.append(ontologyExplanation(historyEventExplanation(event, context.task)));
  if (event.payload && Object.keys(event.payload).length) {
    const payload = element("section", "ontology-inspector-section");
    payload.append(textElement("h3", "", "Payload"), textElement("pre", "inspector-payload", JSON.stringify(event.payload, null, 2)));
    historyDetails.append(payload);
  }
}

function historyEventExplanation(event, task) {
  if (event.type === "task.transitioned") return (task?.title || "The task") + " changed workflow status based on the recorded run result.";
  if (event.type === "task.created") return (task?.title || "A task") + " entered the operational board from its configured workflow trigger.";
  if (event.type === "task.queued") return (task?.title || "The task") + " became ready for its assigned worker.";
  return (task?.title || "This board item") + " recorded “" + eventLabel(event) + "” in the immutable activity stream.";
}

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
  renderWorkflowTrees();
  const query = document.getElementById("task-type-search").value.trim().toLowerCase();
  const visibleTypes = taskTypes.filter(function(definition) {
    return !query || [definition.type, definition.description, definition.kind, definition.defaultAssigneeRole].join(" ").toLowerCase().includes(query);
  });
  document.getElementById("task-type-count").textContent = "Showing " + visibleTypes.length + " of " + taskTypes.length + " task types";
  if (!visibleTypes.some(function(definition) { return definition.type === selectedTaskType; })) selectedTaskType = visibleTypes[0]?.type || null;
  for (const definition of visibleTypes) {
    const metrics = taskTypeMetrics(definition);
    const row = element("button", "type-row" + (definition.type === selectedTaskType ? " selected" : ""));
    row.type = "button";
    row.dataset.taskType = definition.type;
    const copy = element("div", "type-copy");
    const icon = textElement("span", "type-icon", taskTypeIcon(definition.type));
    const text = element("span", "type-copy-text");
    text.append(textElement("span", "type-name", humanize(definition.type)), textElement("span", "type-description", definition.description));
    copy.append(
      icon,
      text,
      textElement("span", "enabled-state", "Enabled")
    );
    row.append(
      copy,
      textElement("span", "type-metric", metrics.lastRun),
      textElement("span", "type-metric", metrics.successRate),
      textElement("span", "type-metric type-steps", String(metrics.steps) + "  ›")
    );
    taskTypeList.append(row);
  }
  renderTaskTypeInspector(taskTypes.find(function(definition) { return definition.type === selectedTaskType; }) || null);
}

function taskTypeMetrics(definition) {
  const runs = boardState.tasks.filter(function(task) { return task.type === definition.type; }).sort(function(left, right) { return String(right.updatedAt).localeCompare(String(left.updatedAt)); });
  const finished = runs.filter(function(task) { return ["done", "failed", "canceled"].includes(task.status); });
  const successes = finished.filter(function(task) { return task.status === "done"; }).length;
  return {
    lastRun: runs[0] ? relativeTime(runs[0].updatedAt) : "Never",
    successRate: finished.length ? Math.round(successes / finished.length * 100) + "%" : "—",
    steps: Math.max(1, (definition.dependsOn || []).length + (definition.requiredBy || []).length + 1)
  };
}

function taskTypeIcon(type) {
  if (/review/i.test(type)) return "⑂";
  if (/ontology|graph/i.test(type)) return "⌘";
  if (/issue|investig/i.test(type)) return "⌕";
  if (/document/i.test(type)) return "▤";
  if (/publish|release/i.test(type)) return "◇";
  return "△";
}

function renderTaskTypeInspector(definition) {
  taskTypeDetails.replaceChildren();
  if (!definition) {
    taskTypeDetails.append(textElement("p", "inspector-empty", "Select a task type to inspect its workflow."));
    return;
  }
  const heading = element("header", "inspector-heading task-type-heading");
  const title = element("div", "inspector-title-row");
  title.append(textElement("span", "type-icon", taskTypeIcon(definition.type)), textElement("strong", "", humanize(definition.type)));
  heading.append(title, textElement("span", "enabled-state", "Enabled"));
  taskTypeDetails.append(heading);

  const trigger = (definition.triggeredBy || [])[0];
  const triggerSection = element("section", "inspector-section");
  triggerSection.append(textElement("h3", "", "Trigger"));
  const triggerCard = element("div", "trigger-card");
  triggerCard.append(textElement("span", "trigger-icon", "⌘"), textElement("span", "", trigger ? trigger.description || humanize(trigger.source) : "Created manually or by an upstream workflow"), textElement("span", "", "⌄"));
  triggerSection.append(triggerCard);
  taskTypeDetails.append(triggerSection);

  const stepsSection = element("section", "inspector-section");
  stepsSection.append(textElement("h3", "", "Workflow steps"));
  const steps = element("div", "workflow-step-list");
  workflowSteps(definition).forEach(function(step, index) {
    const row = element("div", "workflow-step");
    row.append(textElement("span", "step-handle", "⠿"), textElement("span", "step-number", String(index + 1)), textElement("span", "step-copy", step), textElement("span", "step-arrow", "›"));
    steps.append(row);
  });
  stepsSection.append(steps);
  taskTypeDetails.append(stepsSection);

  const config = element("section", "inspector-section configuration-list");
  config.append(textElement("h3", "", "Configuration"));
  const rows = [
    ["Execution", definition.dispatchTopic || "Coordinator managed"],
    ["Assignee", humanize(definition.defaultAssigneeRole)],
    ["Task kind", humanize(definition.kind)],
    ["Retry policy", "2 retries"],
    ["Evidence", "Required"]
  ];
  for (const row of rows) {
    const item = element("div", "configuration-row");
    item.append(textElement("span", "", row[0]), textElement("strong", "", row[1]));
    config.append(item);
  }
  taskTypeDetails.append(config);
  const actions = element("footer", "inspector-actions");
  const edit = textElement("button", "secondary-button", "✎  Edit");
  const run = textElement("button", "primary-button", "▷  Run now");
  edit.type = run.type = "button";
  edit.disabled = run.disabled = true;
  edit.setAttribute("aria-disabled", "true");
  run.setAttribute("aria-disabled", "true");
  edit.title = run.title = "This dashboard currently exposes task type configuration as read-only.";
  actions.append(edit, run);
  taskTypeDetails.append(actions);
}

function workflowSteps(definition) {
  const steps = [];
  for (const dependency of definition.dependsOn || []) steps.push("Wait for " + humanize(dependency.taskType));
  steps.push(definition.description || humanize(definition.type));
  for (const dependent of definition.requiredBy || []) steps.push("Unlock " + humanize(dependent.taskType));
  return steps;
}

function relativeTime(value) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
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

function renderSelectedTask() {
  const taskId = selectedTaskId();
  if (!taskId) {
    if (dialog.open) dialog.close();
    document.body.classList.remove("has-task-inspector");
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
  document.body.classList.add("has-task-inspector");
  if (!dialog.open) dialog.show();
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

function selectedTaskId() {
  const match = location.hash.match(/^#task=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function openTask(taskId) { location.hash = "task=" + encodeURIComponent(taskId); }
function closeTask() {
  history.replaceState(null, "", location.pathname + location.search);
  if (dialog.open) dialog.close();
  document.body.classList.remove("has-task-inspector");
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
function rerenderBoardFilters() {
  const partition = partitionBoardTasks(boardState.tasks);
  renderColumns(filteredBoardTasks(partition.current));
}
document.getElementById("board-search").addEventListener("input", rerenderBoardFilters);
for (const id of ["board-repository", "board-owner", "board-type", "board-status"]) document.getElementById(id).addEventListener("change", rerenderBoardFilters);
for (const id of ["history-search", "history-event-type", "history-actor", "history-repository", "history-date"]) {
  document.getElementById(id).addEventListener(id === "history-search" ? "input" : "change", renderHistory);
}
historyList.addEventListener("click", function(event) {
  const row = event.target.closest("[data-history-event-id]");
  if (!row) return;
  selectedHistoryEventId = row.dataset.historyEventId;
  renderHistory();
});
document.getElementById("task-type-search").addEventListener("input", renderTaskTypes);
contextQuestion.addEventListener("input", function() {
  if (contextSearchLoading) {
    invalidateContextRequest();
    contextState = null;
    contextSearchOpen = false;
    contextEvidenceExpanded = false;
  }
  contextSearchShell.classList.toggle("has-query", Boolean(contextQuestion.value.trim()));
  if (!contextQuestion.value.trim() && !contextSearchLoading) {
    contextState = null;
    contextSearchOpen = false;
    renderOntology();
  }
});
contextQuestion.addEventListener("focus", function() {
  if (contextState || contextSearchLoading) {
    contextSearchOpen = true;
    renderContextResults();
  }
});
contextQuestion.addEventListener("keydown", function(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  invalidateContextRequest();
  contextSearchOpen = false;
  contextEvidenceExpanded = false;
  renderContextResults();
});
document.getElementById("context-search-clear").addEventListener("click", function() {
  invalidateContextRequest();
  contextQuestion.value = "";
  contextState = null;
  contextSearchOpen = false;
  contextEvidenceExpanded = false;
  renderOntology();
  contextQuestion.focus();
});
document.addEventListener("pointerdown", function(event) {
  if (!contextSearchShell.contains(event.target) && contextSearchOpen) {
    if (contextEvidenceExpanded) return;
    invalidateContextRequest();
    contextSearchOpen = false;
    renderContextResults();
  }
});
document.addEventListener("wheel", function(event) {
  if (!contextEvidenceExpanded || !contextSearchOpen || contextSearchResults.hidden || contextSearchResults.contains(event.target)) return;
  if (contextSearchResults.scrollHeight <= contextSearchResults.clientHeight) return;
  event.preventDefault();
  event.stopPropagation();
  contextSearchResults.scrollTop += event.deltaY;
}, { passive: false, capture: true });
taskTypeList.addEventListener("click", function(event) {
  const row = event.target.closest("[data-task-type]");
  if (!row) return;
  selectedTaskType = row.dataset.taskType;
  renderTaskTypes();
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
  if (filter) {
    const menu = filter.closest("details");
    ontologyViewState.filterMenuOpen = Boolean(menu?.open);
    toggleGraphFilter(filter.dataset.filterGroup, filter.dataset.filterType);
  }
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
  const question = contextQuestion.value.trim();
  if (!question || contextSearchLoading) return;
  invalidateContextRequest();
  contextEvidenceExpanded = false;
  const requestSequence = contextRequestSequence;
  const graphKey = ontologyGraphIdentity(graph);
  const abortController = new AbortController();
  contextAbortController = abortController;
  contextSearchOpen = true;
  contextSearchLoading = true;
  contextState = null;
  renderContextResults();
  try {
    const response = await fetch(API + "/ontology/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ repository: graph.repository, ref: graph.ref, question: question })
    });
    if (!response.ok) throw new Error("Context query failed with " + response.status);
    const nextContextState = await response.json();
    if (requestSequence !== contextRequestSequence || contextQuestion.value.trim() !== question || !ontologyState.latest ||
      ontologyGraphIdentity(ontologyState.latest) !== graphKey) return;
    contextState = nextContextState;
  } catch (error) {
    if (requestSequence !== contextRequestSequence || error?.name === "AbortError") return;
    contextState = { error: error instanceof Error ? error.message : String(error) };
  }
  if (requestSequence !== contextRequestSequence) return;
  contextAbortController = null;
  contextSearchLoading = false;
  contextSearchOpen = true;
  renderOntology();
});
document.getElementById("assertion-predicate-filter").addEventListener("change", renderAssertionReview);
document.getElementById("assertion-kind-filter").addEventListener("change", renderAssertionReview);
assertionReviewList.addEventListener("click", async function(event) {
  const button = event.target.closest("[data-assertion-decision]");
  if (!button) return;
  const decision = button.dataset.assertionDecision;
  let rejectionCode;
  let reason;
  if (decision === "reject") {
    const item = button.closest(".assertion-review-item");
    const codeInput = item?.querySelector(".assertion-rejection-code");
    const reasonInput = item?.querySelector(".assertion-rejection-reason");
    rejectionCode = codeInput?.value;
    reason = reasonInput?.value.trim();
    if (!rejectionCode || !reason) {
      reasonInput?.setCustomValidity("Choose a category and provide a reason.");
      reasonInput?.reportValidity();
      return;
    }
    reasonInput.setCustomValidity("");
  }
  button.disabled = true;
  try {
    await reviewAssertion(button.dataset.assertionId, decision, rejectionCode, reason);
  } catch (error) {
    button.disabled = false;
    button.title = error instanceof Error ? error.message : "Assertion review failed";
  }
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
