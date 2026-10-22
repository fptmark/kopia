import "bootstrap/dist/css/bootstrap.min.css";
import "./css/Theme.css";
import "./css/App.css";
import axios from "axios";
import { React, Component } from "react";
import { Navbar, Nav, Container } from "react-bootstrap";
import { BrowserRouter as Router, NavLink, Navigate, Route, Routes } from "react-router";
import { Policy } from "./pages/Policy";
import { About } from "./pages/About";
import { Preferences } from "./pages/Preferences";
import { Policies } from "./pages/Policies";
import { Repository } from "./pages/Repository";
import { Task } from "./pages/Task";
import { Tasks } from "./pages/Tasks";
import { Snapshots } from "./pages/Snapshots";
import { SnapshotCreate } from "./pages/SnapshotCreate";
import { SnapshotDirectory } from "./pages/SnapshotDirectory";
import { SnapshotHistory } from "./pages/SnapshotHistory";
import { SnapshotRestore } from "./pages/SnapshotRestore";
import { SnapshotSearch } from "./pages/SnapshotSearch";
import { AppContext } from "./contexts/AppContext";
import { UIPreferenceProvider } from "./contexts/UIPreferencesContext";
import { FailuresModalHost } from "./utils/uiutil";

export default class App extends Component {
  constructor() {
    super();

    this.state = {
      runningTaskCount: 0,
      isFetching: false,
      repoDescription: "",
      isRepositoryConnected: false,
    };

    this.fetchTaskSummary = this.fetchTaskSummary.bind(this);
    this.repositoryUpdated = this.repositoryUpdated.bind(this);
    this.repositoryDescriptionUpdated = this.repositoryDescriptionUpdated.bind(this);
    this.fetchInitialRepositoryDescription = this.fetchInitialRepositoryDescription.bind(this);

    // The server issues a new CSRF token each time it starts. A page that was opened before a restart
    // is rejected with 401 and cannot recover, so reload it once to pick up the new token.
    axios.interceptors.response.use(undefined, (error) => {
      const body = error?.response?.data;
      if (error?.response?.status === 401 && typeof body === "string" && body.includes("CSRF token")) {
        const last = Number(sessionStorage.getItem("csrfReloadAt") || 0);
        if (Date.now() - last > 15000) {
          sessionStorage.setItem("csrfReloadAt", String(Date.now()));
          window.location.reload();
        }
      }
      return Promise.reject(error);
    });

    const tok = document.head.querySelector('meta[name="kopia-csrf-token"]');
    if (tok && tok.content) {
      axios.defaults.headers.common["X-Kopia-Csrf-Token"] = tok.content;
    } else {
      axios.defaults.headers.common["X-Kopia-Csrf-Token"] = "-";
    }
  }

  componentDidMount() {
    // the version footer stays hidden; the version is shown on the About page instead.
    this.fetchInitialRepositoryDescription();
    this.taskSummaryInterval = window.setInterval(this.fetchTaskSummary, 5000);
  }

  fetchInitialRepositoryDescription() {
    axios
      .get("/api/v1/repo/status")
      .then((result) => {
        if (result.data.description) {
          this.setState({
            repoDescription: result.data.description,
            isRepositoryConnected: result.data.connected,
          });
        }
      })
      .catch((_) => {
        /* ignore */
      });
  }

  fetchTaskSummary() {
    if (!this.state.isFetching) {
      this.setState({ isFetching: true });
      axios
        .get("/api/v1/tasks-summary")
        .then((result) => {
          this.setState({
            isFetching: false,
            runningTaskCount: result.data["RUNNING"] || 0,
          });
        })
        .catch((_) => {
          this.setState({ isFetching: false, runningTaskCount: -1 });
        });
    }
  }

  componentWillUnmount() {
    window.clearInterval(this.taskSummaryInterval);
  }

  // this is invoked via AppContext whenever repository is connected, disconnected, etc.
  repositoryUpdated(isConnected) {
    this.setState({ isRepositoryConnected: isConnected });
    if (isConnected) {
      window.location.replace("/snapshots");
    } else {
      window.location.replace("/repo");
    }
  }

  repositoryDescriptionUpdated(desc) {
    this.setState({
      repoDescription: desc,
    });
  }

  render() {
    const { uiPrefs, runningTaskCount, isRepositoryConnected } = this.state;

    return (
      <Router>
        <AppContext value={this}>
          <UIPreferenceProvider initalValue={uiPrefs}>
            <Navbar expand="sm" variant="light">
              <Navbar.Brand href="/">
                <img src="/kopia-flat.svg" className="App-logo" alt="logo" />
              </Navbar.Brand>
              <Navbar.Toggle aria-controls="basic-navbar-nav" />
              <Navbar.Collapse id="basic-navbar-nav">
                <Nav className="me-auto">
                  <span className="d-inline-block" data-toggle="tooltip" title="Repository is not connected">
                    <NavLink
                      data-testid="tab-snapshots"
                      title=""
                      data-title="Snapshots"
                      className={isRepositoryConnected ? "nav-link" : "nav-link disabled"}
                      to="/snapshots"
                    >
                      Snapshots
                    </NavLink>
                  </span>
                  <span className="d-inline-block" data-toggle="tooltip" title="Repository is not connected">
                    <NavLink
                      data-testid="tab-policies"
                      title=""
                      data-title="Policies"
                      className={isRepositoryConnected ? "nav-link" : "nav-link disabled"}
                      to="/policies"
                    >
                      Policies
                    </NavLink>
                  </span>
                  <span className="d-inline-block" data-toggle="tooltip" title="Repository is not connected">
                    <NavLink
                      data-testid="tab-tasks"
                      title=""
                      data-title="Tasks"
                      className={isRepositoryConnected ? "nav-link" : "nav-link disabled"}
                      to="/tasks"
                    >
                      Tasks
                      <>{runningTaskCount > 0 && <>({runningTaskCount})</>}</>
                    </NavLink>
                  </span>
                  <NavLink data-testid="tab-repo" data-title="Repository" className="nav-link" to="/repo">
                    Repository
                  </NavLink>
                  <NavLink
                    data-testid="tab-preferences"
                    data-title="Preferences"
                    className="nav-link"
                    to="/preferences"
                  >
                    Preferences
                  </NavLink>
                  <NavLink data-testid="tab-about" data-title="About" className="nav-link" to="/about">
                    About
                  </NavLink>
                </Nav>
              </Navbar.Collapse>
            </Navbar>

            <Container fluid>
              <NavLink to="/repo" style={{ color: "inherit", textDecoration: "inherit" }}>
                <h5 className="mb-4">{this.state.repoDescription}</h5>
              </NavLink>

              <Routes>
                <Route path="snapshots" element={<Snapshots />} />
                <Route path="snapshots/new" element={<SnapshotCreate />} />
                <Route path="snapshots/search" element={<SnapshotSearch />} />
                <Route path="snapshots/single-source/" element={<SnapshotHistory />} />
                <Route path="snapshots/dir/:oid/restore" element={<SnapshotRestore />} />
                <Route path="snapshots/dir/:oid" element={<SnapshotDirectory />} />
                <Route path="policies/edit/" element={<Policy />} />
                <Route path="policies" element={<Policies />} />
                <Route path="tasks/:tid" element={<Task />} />
                <Route path="tasks" element={<Tasks />} />
                <Route path="repo" element={<Repository />} />
                <Route path="preferences" element={<Preferences />} />
                <Route path="about" element={<About />} />
                <Route path="/" element={<Navigate to="/snapshots" />} />
              </Routes>
            </Container>
            <FailuresModalHost />
          </UIPreferenceProvider>
        </AppContext>
      </Router>
    );
  }
}
