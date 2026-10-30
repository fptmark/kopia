import { sourceQueryStringParams, PolicyTypeName, policyEditorURL } from "../../src/utils/policyutil";

describe("sourceQueryStringParams", () => {
  it("encodes source parameters correctly", () => {
    const source = {
      userName: "john doe",
      host: "examplehost",
      path: "/home/user/documents",
    };
    const result = sourceQueryStringParams(source);
    expect(result).toContain("userName=john%20doe");
    expect(result).toContain("host=examplehost");
    expect(result).toContain("path=%2Fhome%2Fuser%2Fdocuments");
  });

  it("handles special characters", () => {
    const source = {
      userName: "user@domain",
      host: "test & host",
      path: "/path with spaces",
    };
    const result = sourceQueryStringParams(source);
    expect(result).toContain("userName=user%40domain");
    expect(result).toContain("host=test%20%26%20host");
    expect(result).toContain("path=%2Fpath%20with%20spaces");
  });

  it("handles undefined or null values", () => {
    const source = {
      userName: undefined,
      host: "examplehost",
      path: null,
    };
    const result = sourceQueryStringParams(source);
    expect(result).toContain("userName=undefined");
    expect(result).toContain("host=examplehost");
    expect(result).toContain("path=null");
  });

  it("handles empty values", () => {
    const source = {
      userName: "",
      host: "",
      path: "",
    };
    const result = sourceQueryStringParams(source);
    expect(result).toContain("userName=");
    expect(result).toContain("host=");
    expect(result).toContain("path=");
  });
});

describe("PolicyTypeName", () => {
  it("returns 'Global Policy' for empty source", () => {
    const source = {};
    expect(PolicyTypeName(source)).toBe("Global Policy");
  });

  it("returns 'Global Policy' for source with undefined values", () => {
    const source = { userName: undefined, host: undefined, path: undefined };
    expect(PolicyTypeName(source)).toBe("Global Policy");
  });

  it("returns host name for host-only policy", () => {
    const source = { host: "examplehost" };
    expect(PolicyTypeName(source)).toBe("Host: examplehost");
  });

  it("returns user@host for user policy without path", () => {
    const source = { userName: "john", host: "examplehost" };
    expect(PolicyTypeName(source)).toBe("User: john@examplehost");
  });

  it("returns directory path for full policy", () => {
    const source = {
      userName: "john",
      host: "examplehost",
      path: "/home/john",
    };
    expect(PolicyTypeName(source)).toBe("Directory: john@examplehost:/home/john");
  });

  it("handles special characters in names", () => {
    const source = {
      userName: "user@domain",
      host: "host-with-dashes",
      path: "/path with spaces",
    };
    expect(PolicyTypeName(source)).toBe("Directory: user@domain@host-with-dashes:/path with spaces");
  });
});

describe("policyEditorURL", () => {
  it("generates correct URL with query parameters", () => {
    const source = {
      userName: "john",
      host: "examplehost",
      path: "/home/john",
    };
    const url = policyEditorURL(source);
    expect(url).toContain("/policies/edit?");
    expect(url).toContain("userName=john");
    expect(url).toContain("host=examplehost");
    expect(url).toContain("path=%2Fhome%2Fjohn");
  });

  it("encodes special characters in URL", () => {
    const source = {
      userName: "user@domain",
      host: "test & host",
      path: "/path with spaces",
    };
    const url = policyEditorURL(source);
    expect(url).toContain("userName=user%40domain");
    expect(url).toContain("host=test%20%26%20host");
    expect(url).toContain("path=%2Fpath%20with%20spaces");
  });

  it("handles empty source", () => {
    const source = {};
    const url = policyEditorURL(source);
    expect(url).toBe("/policies/edit?userName=undefined&host=undefined&path=undefined");
  });

  it("generates URL for global policy", () => {
    const source = { userName: "", host: "", path: "" };
    const url = policyEditorURL(source);
    expect(url).toBe("/policies/edit?userName=&host=&path=");
  });
});
