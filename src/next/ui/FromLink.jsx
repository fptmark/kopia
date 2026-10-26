import React, { use } from "react";
import { Link } from "react-router";
import { TrailContext } from "./TrailContext";

/**
 * A link that goes deeper from the current page: the page it opens shows this page's trail, then itself. Use it
 * (also as={FromLink} on a Button) wherever one page opens another that has breadcrumbs.
 */
export function FromLink({ state, ...rest }) {
  return <Link {...rest} state={{ ...state, from: use(TrailContext) }} />;
}
