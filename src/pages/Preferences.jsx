import { use } from "react";
import Col from "react-bootstrap/Col";
import Container from "react-bootstrap/Container";
import Form from "react-bootstrap/Form";
import Row from "react-bootstrap/Row";
import Tab from "react-bootstrap/Tab";
import Tabs from "react-bootstrap/Tabs";
import { BackupHealthPanel } from "../components/BackupHealth";
import { NotificationDestinations } from "../components/NotificationDestinations";
import { UIPreferencesContext } from "../contexts/UIPreferencesContext";

/**
 * Class that exports preferences
 */
export function Preferences() {
  const { theme, bytesStringBase2, fontSize, keepAwake, setByteStringBase, setTheme, setFontSize, setKeepAwake } =
    use(UIPreferencesContext);

  return (
    <Tabs defaultActiveKey="appearance" id="preferences" className="mb-3">
      <Tab eventKey="appearance" title="Appearance" id="tab-appearance">
        <Container fluid>
          <Row>
            <Form.Group as={Col} controlId="theme">
              <Form.Label className="required">Theme</Form.Label>
              <select
                className="form-select form-select-sm"
                title="Select theme"
                id="themeSelector"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
              >
                <option value="light">light</option>
                <option value="dark">dark</option>
                <option value="pastel">pastel</option>
                <option value="ocean">ocean</option>
              </select>
            </Form.Group>
            <Form.Group as={Col} controlId="appearance">
              <Form.Label className="required">Appearance</Form.Label>
              <select
                className="form-select form-select-sm"
                title="Select font size"
                id="fontSizeInput"
                value={fontSize}
                onChange={(e) => setFontSize(e.target.value)}
              >
                <option value="fs-6">small</option>
                <option value="fs-5">medium</option>
                <option value="fs-4">large</option>
              </select>
            </Form.Group>
            <Form.Group as={Col} controlId="byteRepresentation">
              <Form.Label className="required">Byte representation</Form.Label>
              <select
                className="form-select form-select-sm"
                title="Select byte representation"
                id="bytesBaseInput"
                value={bytesStringBase2}
                onChange={(e) => setByteStringBase(e.target.value)}
              >
                <option value="true">Base-2 (KiB, MiB, GiB, TiB)</option>
                <option value="false">Base-10 (KB, MB, GB, TB)</option>
              </select>
            </Form.Group>
          </Row>
        </Container>
      </Tab>
      <Tab eventKey="scheduling" title="Scheduling" id="tab-scheduling">
        <Container fluid>
          <Row>
            <Form.Group as={Col} controlId="keepAwake">
              <Form.Label>Keep Mac awake during snapshots</Form.Label>
              <select
                className="form-select form-select-sm"
                title="Select keep awake mode"
                id="keepAwakeInput"
                value={keepAwake || "never"}
                onChange={(e) => setKeepAwake(e.target.value)}
              >
                <option value="never">Never (system may sleep and interrupt a snapshot)</option>
                <option value="idle">Yes, on any power source (prevents idle sleep)</option>
                <option value="ac">Yes, only while on AC power (prevents idle and system sleep)</option>
              </select>
              <Form.Text muted>
                Uses macOS caffeinate for the duration of each snapshot, scheduled or manual. Closing the lid still
                sleeps the Mac. Applies to snapshots started after the change.
              </Form.Text>
            </Form.Group>
          </Row>
        </Container>
      </Tab>
      <Tab eventKey="health" title="Backup health" id="tab-health">
        <Container fluid>
          <BackupHealthPanel />
        </Container>
      </Tab>
      <Tab eventKey="notifications" title="Notifications" id="tab-notifications">
        <Container fluid>
          <NotificationDestinations />
        </Container>
      </Tab>
    </Tabs>
  );
}
