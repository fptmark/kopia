import React from "react";
import Form from "react-bootstrap/Form";
import { getDeepStateProperty } from "../../utils/deepstate";
import { EffectiveValueColumn } from "./EffectiveValueColumn";

/** The effective value of a policy field; format turns the raw value into what is shown (a period as "1 hr"). */
export function EffectiveValue(component, policyField, format = (x) => x) {
  const dsp = getDeepStateProperty(component, "resolved.definition." + policyField, undefined);

  return (
    <EffectiveValueColumn>
      <Form.Group>
        <Form.Control
          data-testid={"effective-" + policyField}
          size="sm"
          value={format(getDeepStateProperty(component, "resolved.effective." + policyField, undefined))}
          readOnly={true}
        />
        <Form.Text data-testid={"definition-" + policyField}>{component.policyDefinitionPoint(dsp)}</Form.Text>
      </Form.Group>
    </EffectiveValueColumn>
  );
}
