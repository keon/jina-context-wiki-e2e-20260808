"use client";

import { useEffect, useState } from "react";
import { Badge } from "../components/ui";
import { createJinaOrganization, updateJinaOrganization } from "../lib/api";
import { tenantRoleLabel, tenantTypeLabel } from "../lib/tenants";
import { useTenant, useTenantFence } from "../providers";

export default function OrganizationPage() {
  const { selected, addTenant, updateTenant } = useTenant();
  const isCurrentTenant = useTenantFence();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);

  useEffect(() => {
    setName(selected?.login ?? "");
    setSaving(false);
    setSaveMessage(null);
  }, [selected?.tenantId, selected?.login]);

  const saveOrganization = async () => {
    if (!selected || selected.type !== "Organization" || selected.role !== "admin" || saving) return;
    const requestedName = name.trim();
    if (!requestedName || requestedName === selected.login) return;
    const requestTenantId = selected.tenantId;
    setSaving(true);
    setSaveMessage(null);
    try {
      const tenant = await updateJinaOrganization(requestTenantId, requestedName);
      if (!isCurrentTenant(requestTenantId)) return;
      updateTenant(tenant);
      setName(tenant.login);
      setSaveMessage("Organization settings saved.");
    } catch (error) {
      if (isCurrentTenant(requestTenantId)) {
        setSaveMessage(error instanceof Error ? error.message : "Could not update organization");
      }
    } finally {
      if (isCurrentTenant(requestTenantId)) setSaving(false);
    }
  };

  const createOrganization = async () => {
    const requestedName = newName.trim();
    if (!requestedName || creating) return;
    setCreating(true);
    setCreateMessage(null);
    try {
      const tenant = await createJinaOrganization(requestedName);
      addTenant(tenant);
      setNewName("");
      setCreateMessage(`${tenant.login} created and selected.`);
    } catch (error) {
      setCreateMessage(error instanceof Error ? error.message : "Could not create organization");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Workspace settings</span>
          {selected ? <Badge tone="info">{tenantTypeLabel(selected.type)}</Badge> : null}
        </div>
        {selected ? (
          <div className="form">
            <p className="form__lead">
              {selected.type === "Organization"
                ? "This Jina organization is the workspace and billing boundary for its repositories, projects, and artifacts."
                : "Your personal workspace is managed from your GitHub identity. Create a Jina organization for a separate workspace and billing boundary."}
            </p>
            <label className="form-field">
              <span className="form-field__label">
                {selected.type === "Organization" ? "Organization name" : "Workspace name"}
              </span>
              <input
                className="input"
                value={name}
                maxLength={80}
                disabled={selected.type !== "Organization" || selected.role !== "admin" || saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {selected.type === "Organization" ? (
              <>
                {selected.role !== "admin" ? (
                  <p className="tenant-gate-note">Only organization admins can change these settings.</p>
                ) : null}
                <div className="review-stage__actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving || !name.trim() || name.trim() === selected.login}
                    onClick={() => void saveOrganization()}
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </>
            ) : null}
            {saveMessage ? <span className="cell-meta">{saveMessage}</span> : null}
          </div>
        ) : (
          <div className="empty">No workspace is selected.</div>
        )}
      </section>

      {selected ? (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">
              {selected.type === "Organization" ? "Organization metadata" : "Workspace metadata"}
            </span>
          </div>
          <div className="list">
            <MetadataRow label="ID" value={selected.tenantId} code />
            <MetadataRow label="Type" value={tenantTypeLabel(selected.type)} />
            <MetadataRow label="Your role" value={tenantRoleLabel(selected.role)} />
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Create organization</span>
        </div>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void createOrganization();
          }}
        >
          <p className="form__lead">
            Create a Jina workspace first, then connect repositories from one or more GitHub organizations
            on the Integrations page.
          </p>
          <label className="form-field">
            <span className="form-field__label">Organization name</span>
            <input
              className="input"
              value={newName}
              maxLength={80}
              placeholder="Acme Research"
              disabled={creating}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <div className="review-stage__actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={creating || newName.trim().length === 0}
            >
              {creating ? "Creating…" : "Create organization"}
            </button>
          </div>
          {createMessage ? <span className="cell-meta">{createMessage}</span> : null}
        </form>
      </section>
    </>
  );
}

function MetadataRow({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="row">
      <div className="row__main">
        <span className="row__title">{label}</span>
        <span className="row__meta">{code ? <code>{value}</code> : value}</span>
      </div>
    </div>
  );
}
