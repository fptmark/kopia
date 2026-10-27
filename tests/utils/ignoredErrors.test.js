import axios from "axios";
import { vi } from "vitest";
import { addIgnoredError } from "../../src/utils/ignoredErrors";

vi.mock("axios");

afterEach(() => vi.resetAllMocks());

describe("addIgnoredError", () => {
  it("posts the rule", async () => {
    axios.post.mockResolvedValue({ data: { id: "a" } });

    await expect(addIgnoredError({ path: "a", scope: "file" })).resolves.toEqual({ id: "a" });
    expect(axios.post).toHaveBeenCalledWith("/api/v1/ignored-errors", { path: "a", scope: "file" });
  });
});
