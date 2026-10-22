import axios from "axios";
import React, { Component } from "react";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Col from "react-bootstrap/Col";
import Row from "react-bootstrap/Row";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import Spinner from "react-bootstrap/Spinner";
import { handleChange } from "../forms";
import { SetupRepository } from "../components/SetupRepository";
import { CLIEquivalent } from "../components/CLIEquivalent";
import { cancelTask } from "../utils/taskutil";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faChevronCircleDown, faChevronCircleUp, faWindowClose } from "@fortawesome/free-solid-svg-icons";
import { Logs } from "../components/Logs";
import { AppContext } from "../contexts/AppContext";
import { sizeDisplayName } from "../utils/formatutils";

export class Repository extends Component {
  constructor() {
    super();

    this.state = {
      status: {},
      isLoading: true,
      error: null,
      provider: "",
      description: "",
      usage: null,
      usageLoading: false,
      usageError: null,
      usageElapsedSec: 0,
    };

    this.mounted = false;
    this.disconnect = this.disconnect.bind(this);
    this.updateDescription = this.updateDescription.bind(this);
    this.handleChange = handleChange.bind(this);
    this.fetchStatus = this.fetchStatus.bind(this);
    this.fetchStatusWithoutSpinner = this.fetchStatusWithoutSpinner.bind(this);
    this.fetchStorageUsage = this.fetchStorageUsage.bind(this);
    this.stopUsageTimer = this.stopUsageTimer.bind(this);
    this.startUsageTimer = this.startUsageTimer.bind(this);
  }

  // Listing every blob can take a long time on remote storage, so this only runs on demand.
  stopUsageTimer() {
    if (this.usageTimer) {
      window.clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
  }

  // While the server calculates in the background, poll it and tick the elapsed time shown on screen.
  startUsageTimer(startedAt) {
    if (this.usageTimer) {
      return;
    }

    const started = startedAt ? Date.parse(startedAt) : Date.now();
    const elapsed = () => Math.max(0, Math.floor((Date.now() - started) / 1000));
    this.setState({ usageElapsedSec: elapsed() });

    let ticks = 0;
    this.usageTimer = window.setInterval(() => {
      ticks++;
      this.setState({ usageElapsedSec: elapsed() });
      if (ticks % 2 === 0) {
        this.fetchStorageUsage(false);
      }
    }, 1000);
  }

  // The calculation runs on the server, independent of this page, so it keeps going if the user
  // leaves. Fetching without refresh only reads the last saved result and whether one is running.
  fetchStorageUsage(refresh) {
    if (refresh) {
      this.setState({ usageLoading: true, usageError: null, usageElapsedSec: 0 });
    }

    axios
      .get("/api/v1/repo/storage-usage", { params: { refresh: refresh ? "true" : "false" } })
      .then((result) => {
        if (!this.mounted) {
          return;
        }

        const d = result.data;
        // zero totals mean nothing has been calculated yet.
        const calculated = d.blobCount > 0 || d.totalBytes > 0;
        this.setState({
          usage: calculated ? d : null,
          usageLoading: !!d.running,
          usageError: d.running ? null : d.error || null,
        });

        if (d.running) {
          this.startUsageTimer(d.startedAt);
        } else {
          this.stopUsageTimer();
        }
      })
      .catch((e) => {
        if (this.mounted && refresh) {
          this.stopUsageTimer();
          this.setState({
            usageLoading: false,
            usageError: e.response?.data?.error || String(e),
          });
        }
      });
  }

  componentDidMount() {
    this.mounted = true;
    this.fetchStatus(this.props);
    this.fetchStorageUsage(false);
  }

  componentWillUnmount() {
    this.mounted = false;
    this.stopUsageTimer();
  }

  fetchStatus() {
    if (this.mounted) {
      this.setState({
        isLoading: true,
      });
    }

    this.fetchStatusWithoutSpinner();
  }

  fetchStatusWithoutSpinner() {
    axios
      .get("/api/v1/repo/status")
      .then((result) => {
        if (this.mounted) {
          this.setState({
            status: result.data,
            isLoading: false,
          });

          // Update the app context to reflect the successfully-loaded description.
          this.context.repositoryDescriptionUpdated(result.data.description);

          if (result.data.initTaskID) {
            window.setTimeout(() => {
              this.fetchStatusWithoutSpinner();
            }, 1000);
          }
        }
      })
      .catch((error) => {
        if (this.mounted) {
          this.setState({
            error,
            isLoading: false,
          });
        }
      });
  }

  disconnect() {
    this.setState({ isLoading: true });
    axios
      .post("/api/v1/repo/disconnect", {})
      .then((_result) => {
        this.context.repositoryUpdated(false);
      })
      .catch((error) =>
        this.setState({
          error,
          isLoading: false,
        }),
      );
  }

  updateDescription() {
    this.setState({
      isLoading: true,
    });

    axios
      .post("/api/v1/repo/description", {
        description: this.state.status.description,
      })
      .then((result) => {
        // Update the app context to reflect the successfully-saved description.
        this.context.repositoryDescriptionUpdated(result.data.description);

        this.setState({
          isLoading: false,
        });
      })
      .catch((_error) => {
        this.setState({
          isLoading: false,
        });
      });
  }

  render() {
    let { isLoading, error } = this.state;
    if (error) {
      return <p>{error.message}</p>;
    }

    if (isLoading) {
      return <Spinner animation="border" variant="primary" />;
    }

    if (this.state.status.initTaskID) {
      return (
        <>
          <h4>
            <Spinner animation="border" variant="primary" size="sm" />
            &nbsp;Initializing Repository...
          </h4>
          {this.state.showLog ? (
            <>
              <Button size="sm" variant="light" onClick={() => this.setState({ showLog: false })}>
                <FontAwesomeIcon icon={faChevronCircleUp} /> Hide Log
              </Button>
              <Logs taskID={this.state.status.initTaskID} />
            </>
          ) : (
            <Button size="sm" variant="light" onClick={() => this.setState({ showLog: true })}>
              <FontAwesomeIcon icon={faChevronCircleDown} /> Show Log
            </Button>
          )}
          <hr />
          <Button
            size="sm"
            variant="danger"
            icon={faWindowClose}
            title="Cancel"
            onClick={() => cancelTask(this.state.status.initTaskID)}
          >
            Cancel Connection
          </Button>
        </>
      );
    }

    if (this.state.status.connected) {
      return (
        <>
          <p className="text-success mb-1">
            <FontAwesomeIcon icon={faCheck} style={{ marginRight: 4 }} />
            <span>Connected To Repository</span>
          </p>
          <Form>
            <Row>
              <Form.Group as={Col}>
                <InputGroup>
                  <Form.Control
                    autoFocus={true}
                    isInvalid={!this.state.status.description}
                    name="status.description"
                    value={this.state.status.description}
                    onChange={this.handleChange}
                    size="sm"
                  />
                  &nbsp;
                  <Button data-testid="update-description" size="sm" onClick={this.updateDescription} type="button">
                    Update Description
                  </Button>
                </InputGroup>
                <Form.Control.Feedback type="invalid">Description Is Required</Form.Control.Feedback>
              </Form.Group>
            </Row>
            {this.state.status.readonly && (
              <Row>
                <Badge pill variant="warning">
                  Repository is read-only
                </Badge>
              </Row>
            )}
          </Form>
          <hr />
          <Form>
            {this.state.status.apiServerURL ? (
              <>
                <Row>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Server URL</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.apiServerURL} />
                  </Form.Group>
                </Row>
              </>
            ) : (
              <>
                <Row>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Config File</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.configFile} />
                  </Form.Group>
                </Row>
                <Row>
                  <Form.Group as={Col}>
                    <Form.Label>Total Size on Storage</Form.Label>
                    <InputGroup>
                      <Form.Control
                        readOnly
                        data-testid="storage-usage"
                        value={
                          this.state.usageLoading
                            ? "Calculating... " +
                              Math.floor(this.state.usageElapsedSec / 60) +
                              ":" +
                              String(this.state.usageElapsedSec % 60).padStart(2, "0") +
                              " elapsed (listing every file on the storage, this can take a few minutes)"
                            : this.state.usageError
                              ? "Error: " + this.state.usageError
                              : this.state.usage
                                ? sizeDisplayName(this.state.usage.totalBytes, false) +
                                  " in " +
                                  this.state.usage.blobCount.toLocaleString() +
                                  " blobs (as of " +
                                  new Date(this.state.usage.computedAt).toLocaleString() +
                                  ")"
                                : "Not calculated yet (press Calculate)"
                        }
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        data-testid="refresh-storage-usage"
                        disabled={this.state.usageLoading}
                        onClick={() => this.fetchStorageUsage(true)}
                      >
                        {this.state.usageLoading ? (
                          <>
                            <Spinner animation="border" size="sm" /> Calculating...
                          </>
                        ) : this.state.usage ? (
                          "Refresh"
                        ) : (
                          "Calculate"
                        )}
                      </Button>
                    </InputGroup>
                  </Form.Group>
                </Row>
                <Row>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Provider</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.storage} />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Encryption Algorithm</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.encryption} />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Hash Algorithm</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.hash} />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Splitter Algorithm</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.splitter} />
                  </Form.Group>
                </Row>
                <Row>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Repository Format</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.formatVersion} />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Error Correction Overhead</Form.Label>
                    <Form.Control
                      readOnly
                      defaultValue={
                        this.state.status.eccOverheadPercent > 0
                          ? this.state.status.eccOverheadPercent + "%"
                          : "Disabled"
                      }
                    />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Error Correction Algorithm</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.ecc || "-"} />
                  </Form.Group>
                  <Form.Group as={Col}>
                    <Form.Label className="required">Internal Compression</Form.Label>
                    <Form.Control readOnly defaultValue={this.state.status.supportsContentCompression ? "yes" : "no"} />
                  </Form.Group>
                </Row>
              </>
            )}
            <Row>
              <Form.Group as={Col}>
                <Form.Label className="required">Connected as:</Form.Label>
                <Form.Control readOnly defaultValue={this.state.status.username + "@" + this.state.status.hostname} />
              </Form.Group>
            </Row>
            <Row>
              <Col>&nbsp;</Col>
            </Row>
            <Row>
              <Col>
                <Button data-testid="disconnect" size="sm" variant="danger" onClick={this.disconnect}>
                  Disconnect
                </Button>
              </Col>
            </Row>
          </Form>
          <Row>
            <Col>&nbsp;</Col>
          </Row>
          <Row>
            <Col xs={12}>
              <CLIEquivalent command="repository status" />
            </Col>
          </Row>
        </>
      );
    }

    return <SetupRepository />;
  }
}

Repository.contextType = AppContext;
