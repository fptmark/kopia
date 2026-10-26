import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import {
  ConfirmDialog,
  CountText,
  DataTable,
  DateTimeText,
  EmptyState,
  Field,
  FormSection,
  Loading,
  Notice,
  Page,
  Panel,
  PathText,
  SearchBox,
  SizeText,
  Stat,
  Stats,
  StatusBadge,
  SwitchField,
  TabNav,
  Toolbar,
} from "../ui";

const SAMPLE = Array.from({ length: 37 }, (_, i) => ({
  id: "row" + i,
  change: ["added", "removed", "modified"][i % 3],
  path:
    ["Library/Caches", "Projects/site/node_modules", "Documents/notes.md", ".Trash"][i % 4] + (i > 3 ? "/" + i : ""),
  size: (i + 1) * 123456789,
  files: (i + 1) * 3571,
  when: new Date(Date.now() - i * 3600 * 1000 * 7).toISOString(),
}));

/**
 * Every building block of the UI, with sample data, on one page. A page that needs something that is not here
 * adds it here first. This page is also what is screenshotted to check the look in light and dark mode.
 */
export function Spec() {
  const [tab, setTab] = useState("one");
  const [selected, setSelected] = useState({ row1: true });
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [on, setOn] = useState(true);
  const rows = SAMPLE.filter((r) => r.path.toLowerCase().includes(filter.toLowerCase()));

  const columns = [
    { id: "change", header: "Change", accessor: (r) => r.change, cell: (r) => <StatusBadge kind={r.change} /> },
    { id: "path", header: "Path", accessor: (r) => r.path, cell: (r) => <PathText>{r.path}</PathText> },
    { id: "size", header: "Size", align: "end", accessor: (r) => r.size, cell: (r) => <SizeText bytes={r.size} /> },
    { id: "files", header: "Files", align: "end", accessor: (r) => r.files, cell: (r) => <CountText n={r.files} /> },
    { id: "when", header: "When", accessor: (r) => r.when, cell: (r) => <DateTimeText value={r.when} ago /> },
  ];

  return (
    <Page
      title="Components"
      subtitle="Everything the pages are built from"
      back="/snapshots"
      actions={
        <>
          <Button variant="secondary">Secondary</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="danger" disabled>
            Muted
          </Button>
        </>
      }
    >
      <Panel title="Panel with stats" note="a note about the panel">
        <Stats>
          <Stat label="Before" value="Oct 23, 2026, 2:01 PM" note="204.8 GB logical" />
          <Stat label="After" value="Oct 23, 2026, 5:22 PM" note="230 GB logical" />
          <Stat label="Added" value="644.7K files" note="25.2 GB" />
        </Stats>
      </Panel>

      <Toolbar>
        <Toolbar.Group label="Show" grow>
          <Form.Check inline type="checkbox" id="a" label="added" defaultChecked />
          <Form.Check inline type="checkbox" id="r" label="removed" defaultChecked />
          <SearchBox value={filter} onChange={setFilter} placeholder="Filter by path" />
        </Toolbar.Group>
        <Toolbar.Group end>
          <span className="nx-muted small">{Object.keys(selected).length} selected</span>
          <Button
            size="sm"
            variant="danger"
            disabled={Object.keys(selected).length === 0}
            onClick={() => setConfirm(true)}
          >
            Exclude
          </Button>
        </Toolbar.Group>
      </Toolbar>

      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        selection={{ selected, onChange: setSelected, isSelectable: (r) => r.change !== "removed" }}
        initialSort={{ id: "size", desc: true }}
        pageSize={10}
        label="sample"
      />

      <Panel title="Status badges">
        {["added", "removed", "modified", "ok", "warning", "error", "running", "info", "neutral"].map((k) => (
          <span key={k} >
            <StatusBadge kind={k} />
          </span>
        ))}
      </Panel>

      <Panel title="Notices">
        <Notice kind="success">Saved.</Notice>
        <Notice kind="error" title="Not saved.">
          The policy is locked.
        </Notice>
        <Notice kind="warning">This rule matches nothing.</Notice>
        <Notice kind="info">The next snapshot skips it.</Notice>
      </Panel>

      <Panel title="Form">
        <TabNav
          tabs={[
            { id: "one", label: "General" },
            { id: "two", label: "Rules", badge: 15 },
          ]}
          active={tab}
          onChange={setTab}
        />
        <FormSection title="Backup">
          <Field label="Name" help="Shown in the title.">
            {(id) => <Form.Control id={id} defaultValue="Repository" />}
          </Field>
          <Field label="Retention" error="Must be a number.">
            {(id) => <Form.Control id={id} defaultValue="abc" isInvalid />}
          </Field>
          <SwitchField label="Keep the Mac awake" help="While a snapshot runs." checked={on} onChange={setOn} />
        </FormSection>
      </Panel>

      <Panel title="Loading and empty">
        <Loading />
        <EmptyState>Nothing to show.</EmptyState>
      </Panel>

      <ConfirmDialog
        show={confirm}
        title="Exclude from backup"
        confirmLabel="Exclude"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => setConfirm(false)}
      >
        Stop backing up these paths?
      </ConfirmDialog>
    </Page>
  );
}
