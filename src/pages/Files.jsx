import Tab from "react-bootstrap/Tab";
import Tabs from "react-bootstrap/Tabs";
import { ExcludedFiles } from "../components/ExcludedFiles";
import { SnapshotSearch } from "./SnapshotSearch";

/** Finding and restoring files in snapshots, and the files that are left out of them. */
export function Files() {
  return (
    <Tabs defaultActiveKey="restore" id="files" className="mb-3">
      <Tab eventKey="restore" title="List/Restore" id="tab-list-restore">
        <SnapshotSearch />
      </Tab>
      <Tab eventKey="excluded" title="Excluded" id="tab-excluded">
        <ExcludedFiles />
      </Tab>
    </Tabs>
  );
}
