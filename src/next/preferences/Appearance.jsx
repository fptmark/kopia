import React, { use } from "react";
import Form from "react-bootstrap/Form";
import { PAGE_SIZES, UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { Field, FormSection } from "../ui";

/** How the pages look: light or dark, text size, how sizes are written, and how many rows a table shows. */
export function Appearance() {
  const { theme, fontSize, bytesStringBase2, pageSize, setTheme, setFontSize, setByteStringBase, setPageSize } =
    use(UIPreferencesContext);

  return (
    <FormSection>
      <div className="row">
        <div className="col-md-6 col-lg-3">
          <Field label="Theme" help="Pastel and ocean, from the old UI, show as light.">
            {(id) => (
              <Form.Select
                id={id}
                value={theme === "dark" ? "dark" : "light"}
                onChange={(e) => setTheme(e.target.value)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Form.Select>
            )}
          </Field>
        </div>
        <div className="col-md-6 col-lg-3">
          <Field label="Text size">
            {(id) => (
              <Form.Select id={id} value={fontSize} onChange={(e) => setFontSize(e.target.value)}>
                <option value="fs-6">Small</option>
                <option value="fs-5">Medium</option>
                <option value="fs-4">Large</option>
              </Form.Select>
            )}
          </Field>
        </div>
        <div className="col-md-6 col-lg-3">
          <Field label="Sizes are written in" help="Base 10 is what Finder and disk makers use.">
            {(id) => (
              <Form.Select
                id={id}
                value={String(!!bytesStringBase2)}
                onChange={(e) => setByteStringBase(e.target.value)}
              >
                <option value="false">Base 10 (KB, MB, GB, TB)</option>
                <option value="true">Base 2 (KiB, MiB, GiB, TiB)</option>
              </Form.Select>
            )}
          </Field>
        </div>
        <div className="col-md-6 col-lg-3">
          <Field label="Rows per table page" help="Each table can also be changed on its own page.">
            {(id) => (
              <Form.Select id={id} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Form.Select>
            )}
          </Field>
        </div>
      </div>
    </FormSection>
  );
}
