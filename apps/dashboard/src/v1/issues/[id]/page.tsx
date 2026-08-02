"use client";

import { use } from "react";
import { IssueDetail } from "../../components/issues";

export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <IssueDetail id={decodeURIComponent(id)} />;
}
