#!/usr/bin/env python3
"""Self-hosted PageIndex bridge for derived Markdown context.

The process accepts one JSON request on stdin and writes one JSON response on
stdout. It deliberately does not know about tenants, GitHub credentials, GCS,
or raw repository evidence. The TypeScript caller supplies already-authorized,
citation-valid derived documents and remains the authority for IDs and ACLs.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

pageindex_source = os.environ.get("PAGEINDEX_SOURCE_ROOT")
if pageindex_source:
    # Import the Markdown module directly rather than through the ``pageindex``
    # package. Importing ``pageindex.page_index_md`` executes ``__init__.py``,
    # which eagerly imports the PDF, retrieval, and client modules even though
    # this bridge never uses them. Those files are intentionally outside the
    # two-file source digest below, so executing them would make the attestation
    # weaker than the actual runtime boundary.
    sys.path.insert(0, str(Path(pageindex_source).resolve() / "pageindex"))

page_index_md = importlib.import_module("page_index_md")
build_tree_from_nodes = page_index_md.build_tree_from_nodes
extract_node_text_content = page_index_md.extract_node_text_content
extract_nodes_from_markdown = page_index_md.extract_nodes_from_markdown

ADAPTER_NAME = "pageindex-oss-markdown"
ADAPTER_VERSION = "982514ab40fe42a169ea087c13819cf87c87724f"
SOURCE_PIN = ADAPTER_VERSION
SOURCE_DIGEST = "b96135e27a2f725971a90ada1c8979d9110d640778bcbdae57b1587f97ffc0a5"


def verified_source_digest() -> str:
    """Verify the exact pinned OSS files used by this bridge.

    A version constant alone is not an attestation: a different checkout could
    be mounted beneath the same bridge. The digest covers the Markdown
    implementation and the utility module it imports. It also works in the
    production image, where the PageIndex `.git` directory is deliberately
    absent.
    """

    module_path = Path(page_index_md.__file__ or "").resolve()
    if module_path.name != "page_index_md.py":
        raise RuntimeError("PageIndex Markdown source path is not verifiable")
    source_files = (module_path, module_path.with_name("utils.py"))
    digest = hashlib.sha256()
    for source_file in source_files:
        if not source_file.is_file():
            raise RuntimeError(f"PageIndex pinned source file is missing: {source_file.name}")
        digest.update(source_file.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(source_file.read_bytes())
        digest.update(b"\0")
    actual = digest.hexdigest()
    if actual != SOURCE_DIGEST:
        raise RuntimeError(
            f"PageIndex source digest mismatch: expected {SOURCE_DIGEST}, got {actual}"
        )
    return actual


def stable_external_id(document_id: str, native_id: str) -> str:
    digest = hashlib.sha256(f"{document_id}\0{native_id}".encode("utf-8")).hexdigest()
    return f"pageindex-{digest[:32]}"


def compact_summary(text: str, title: str) -> str:
    paragraphs = [
        " ".join(line.strip() for line in paragraph.splitlines()).strip()
        for paragraph in text.split("\n\n")
    ]
    prose = next(
        (
            paragraph
            for paragraph in paragraphs
            if paragraph and not paragraph.lstrip().startswith("#")
        ),
        title,
    )
    return prose[:500]


def document_nodes(document: dict[str, Any]) -> list[dict[str, Any]]:
    raw_nodes, lines = extract_nodes_from_markdown(document["body"])
    if not raw_nodes:
        raw_nodes = [{"node_title": document["title"], "line_num": 1, "level": 1}]
    tree = build_tree_from_nodes(extract_node_text_content(raw_nodes, lines))
    output: list[dict[str, Any]] = []
    preorder = 0

    def visit(node: dict[str, Any], parent_native_id: Optional[str], depth: int) -> int:
        nonlocal preorder
        preorder += 1
        start = preorder
        native_id = str(node["node_id"])
        children = node.get("nodes", [])
        for child in children:
            visit(child, native_id, depth + 1)
        end = preorder
        external_id = stable_external_id(document["id"], native_id)
        output.append(
            {
                "externalId": external_id,
                "documentId": document["id"],
                **(
                    {
                        "parentExternalId": stable_external_id(
                            document["id"], parent_native_id
                        )
                    }
                    if parent_native_id is not None
                    else {}
                ),
                "title": node["title"],
                "summary": compact_summary(node.get("text", ""), node["title"]),
                "depth": depth,
                "preorderStart": start,
                "preorderEnd": end,
                "anchors": document["anchors"],
            }
        )
        return end

    for root in tree:
        visit(root, None, 1)
    output.sort(key=lambda node: (node["preorderStart"], node["externalId"]))
    return output


def build(request: dict[str, Any]) -> dict[str, Any]:
    source_digest = verified_source_digest()
    limits = request["limits"]
    documents = request["documents"]
    if len(documents) > limits["maxNodes"]:
        raise ValueError("document count exceeds maxNodes")
    nodes = [node for document in documents for node in document_nodes(document)]
    if len(nodes) > limits["maxNodes"]:
        raise ValueError("PageIndex tree exceeds maxNodes")
    return {
        "adapterName": ADAPTER_NAME,
        "adapterVersion": ADAPTER_VERSION,
        "sourcePin": SOURCE_PIN,
        "sourceDigest": source_digest,
        "nodes": nodes,
        "diagnostics": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        try:
            print(
                json.dumps(
                    {
                        "available": True,
                        "adapterName": ADAPTER_NAME,
                        "version": ADAPTER_VERSION,
                        "sourcePin": SOURCE_PIN,
                        "sourceDigest": verified_source_digest(),
                    },
                    separators=(",", ":"),
                )
            )
            return 0
        except Exception as error:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 1
    try:
        request = json.load(sys.stdin)
        if request.get("operation") != "build":
            raise ValueError("unsupported operation")
        print(json.dumps(build(request["input"]), separators=(",", ":")))
        return 0
    except Exception as error:  # the caller converts this to a failed hierarchy projector
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
