import { createContext } from "react";

/**
 * Where a page's table puts its pager: the end of the page's Toolbar, so paging costs no line of its own.
 * Page provides { slot, setSlot }; Toolbar registers its end element; DataTable renders into it.
 */
export const PagerSlotContext = createContext(null);
