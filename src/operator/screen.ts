import terminalKit from "terminal-kit";

import {
  detailText,
  headerText,
  rosterItems,
  seatHeading,
} from "./presentation.js";
import type {
  Document,
  Element,
  MenuElement,
  Terminal,
  TextBoxElement,
} from "terminal-kit";
import type { OperatorState } from "./types.js";

interface ScreenHandlers {
  cycleFilter(): void;
  find(): Promise<void>;
  help(): Promise<void>;
  quit(): void;
  refresh(): Promise<void>;
  reportError(error: unknown): void;
  select(seatId: string): void;
  tail(): void;
  toggleDetail(): void;
}

export interface OperatorScreen {
  getDocument(): Document;
  getTerminal(): Terminal;
  setModal(open: boolean): void;
  start(): void;
  stop(): void;
  tail(): void;
  update(state: OperatorState): void;
}

export type FocusPane = "detail" | "roster";

export function nextFocusPane(pane: FocusPane): FocusPane {
  return pane === "roster" ? "detail" : "roster";
}

export function createOperatorScreen(
  state: OperatorState,
  handlers: ScreenHandlers,
  monochrome = false,
): OperatorScreen {
  let terminal = terminalKit.terminal;
  let document: Document | null = null;
  let focusPane: FocusPane = "roster";
  let modalOpen = false;
  let stopped = false;
  let resizeTimer: NodeJS.Timeout | null = null;
  let layoutSignature = "";
  let rendered = {
    detail: "",
    footer: "",
    footerAttr: "",
    header: "",
    headerAttr: "",
    heading: "",
    selectedId: null as string | null,
  };
  let widgets: {
    detail: TextBoxElement;
    detailHeading: Element;
    footer: Element;
    header: Element;
    roster: MenuElement;
  } | null = null;
  let keyHandler = (key: string) => handleKey(key);
  let resizeHandler = () => scheduleRebuild();

  function start(): void {
    terminal.fullscreen(true);
    terminal.hideCursor(true);
    terminal.clear();
    terminal.on("key", keyHandler);
    terminal.on("resize", resizeHandler);
    rebuild();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    terminal.off("key", keyHandler);
    terminal.off("resize", resizeHandler);
    document?.destroy();
    terminal.grabInput(false);
    terminal.hideCursor(false);
    terminal.styleReset();
    terminal.fullscreen(false);
  }

  function update(nextState: OperatorState): void {
    Object.assign(state, nextState);
    if (modalOpen) return;
    let nextSignature = screenLayoutSignature();
    if (!widgets || nextSignature !== layoutSignature) {
      rebuild();
      return;
    }
    updateWidgets();
  }

  function setModal(open: boolean): void {
    modalOpen = open;
    if (!open) rebuild();
  }

  function getDocument(): Document {
    if (!document) throw new Error("Operator screen has not started.");
    return document;
  }

  function getTerminal(): Terminal {
    return terminal;
  }

  function tail(): void {
    if (!widgets) return;
    widgets.detail.scrollToBottom();
    state.detailScrollY = widgets.detail.scrollY;
    terminal.hideCursor(true);
  }

  function scheduleRebuild(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!modalOpen) rebuild();
    }, 50);
  }

  function rebuild(): void {
    if (stopped) return;
    document?.destroy();
    terminal.clear();
    widgets = null;
    document = terminal.createDocument({
      backgroundAttr: { bgColor: "black", color: "white" },
      keyBindings: {},
    });
    if (terminal.width < 60 || terminal.height < 16) {
      renderTooSmall(document);
      return;
    }
    let header = renderHeader(document);
    let rosterMenu = renderRoster(document);
    let detailWidgets = renderDetail(document);
    let footer = renderFooter(document);
    widgets = {
      detail: detailWidgets.detail,
      detailHeading: detailWidgets.heading,
      footer,
      header,
      roster: rosterMenu,
    };
    layoutSignature = screenLayoutSignature();
    rendered = renderedContent();
    if (state.selectedId) {
      rosterMenu.focusValue(state.selectedId, "select", true);
      rendered.selectedId = state.selectedId;
    }
    if (focusPane === "detail") document.giveFocusTo(detailWidgets.detail);
    terminal.hideCursor(true);
  }

  function renderHeader(parent: Document): Element {
    return new terminalKit.Text({
      attr: headerAttr(),
      content: headerText(state.snapshot).padEnd(terminal.width),
      height: 1,
      parent,
      width: terminal.width,
      x: 0,
      y: 0,
    });
  }

  function renderRoster(parent: Document): MenuElement {
    let rosterWidth = Math.min(
      38,
      Math.max(26, Math.floor(terminal.width * 0.3)),
    );
    let menu = new terminalKit.ColumnMenu({
      autoHeight: false,
      autoWidth: false,
      buttonBlurAttr: { bgColor: "black", color: "white" },
      buttonDisabledAttr: themedAttr(
        { bgColor: "black", bold: true, color: "brightBlack" },
        { bgColor: "black", bold: true, color: "white", dim: true },
      ),
      buttonFocusAttr: themedAttr(
        { bgColor: "blue", bold: true, color: "brightWhite" },
        { bgColor: "white", bold: true, color: "black" },
      ),
      focusLeftPadding: "›",
      height: terminal.height - 2,
      items: rosterItems(state.visibleSeats, rosterWidth - 2),
      maxHeight: terminal.height - 2,
      parent,
      width: rosterWidth,
      x: 0,
      y: 1,
    });
    menu.on("itemFocus", (value: unknown, focused: boolean) => {
      if (!focused) return;
      focusPane = "roster";
      if (typeof value === "string" && !value.startsWith("heading:"))
        handlers.select(value);
    });
    menu.on("submit", (value: unknown) => {
      if (typeof value === "string" && !value.startsWith("heading:"))
        handlers.select(value);
    });
    return menu;
  }

  function renderDetail(parent: Document): {
    detail: TextBoxElement;
    heading: Element;
  } {
    let rosterWidth = Math.min(
      38,
      Math.max(26, Math.floor(terminal.width * 0.3)),
    );
    let detailX = rosterWidth + 1;
    let detailWidth = terminal.width - detailX;
    let heading = new terminalKit.Text({
      attr: { bold: true, color: "brightWhite" },
      content: seatHeading(state.selectedSeat),
      height: 1,
      parent,
      width: detailWidth,
      x: detailX,
      y: 1,
    });
    renderTab(parent, "Activity", "activity", detailX, 2);
    renderTab(parent, "Memory", "memory", detailX + 12, 2);
    let entries = state.selectedLog?.entries ?? null;
    let content = detailText(
      state.selectedSeat,
      state.detailView,
      entries,
      state.query,
    );
    let detail = new terminalKit.TextBox({
      altTextAttr: { color: "brightBlack", italic: true },
      content,
      height: terminal.height - 5,
      lineWrap: true,
      parent,
      scrollable: true,
      textAttr: { bgColor: "black", color: "white" },
      voidAttr: { bgColor: "black", color: "white" },
      vScrollBar: true,
      width: detailWidth,
      wordWrap: true,
      x: detailX,
      y: 3,
    });
    detail.on("scroll", () => {
      state.follow = false;
      state.detailScrollY = detail.scrollY;
    });
    detail.on("focus", (focused: boolean) => {
      if (focused) focusPane = "detail";
    });
    if (state.follow && state.detailView === "activity")
      detail.scrollToBottom(true);
    else detail.scrollTo(null, state.detailScrollY, true);
    return { detail, heading };
  }

  function renderTab(
    parent: Document,
    label: string,
    view: "activity" | "memory",
    positionX: number,
    positionY: number,
  ): Element {
    let active = state.detailView === view;
    let button = new terminalKit.Button({
      blurAttr: themedAttr(
        {
          bgColor: active ? "cyan" : "brightBlack",
          bold: active,
          color: active ? "black" : "white",
        },
        {
          bgColor: active ? "white" : "black",
          bold: active,
          color: active ? "black" : "white",
        },
      ),
      content: ` ${label} `,
      focusAttr: themedAttr(
        { bgColor: "blue", bold: true, color: "brightWhite" },
        { bgColor: "white", bold: true, color: "black" },
      ),
      parent,
      value: view,
      x: positionX,
      y: positionY,
    });
    button.on("focus", (focused: boolean) => {
      if (focused) focusPane = "detail";
    });
    button.on("submit", () => {
      if (state.detailView !== view) {
        handlers.toggleDetail();
        return;
      }
      if (widgets && document) document.giveFocusTo(widgets.detail);
    });
    return button;
  }

  function renderFooter(parent: Document): Element {
    let notice =
      state.notice && state.notice.until > Date.now()
        ? ` ${state.notice.text}`
        : null;
    let find = state.query ? ` · find:${state.query}` : "";
    let text =
      notice ??
      ` [/] Find  [M] ${state.detailView === "memory" ? "Activity" : "Memory"}  [G] Tail  [F] ${state.filter}  [Tab] Focus  [?] Help  [Q] Quit${find}`;
    return new terminalKit.Text({
      attr: footerAttr(),
      content: text.padEnd(terminal.width),
      height: 1,
      parent,
      width: terminal.width,
      x: 0,
      y: terminal.height - 1,
    });
  }

  function renderTooSmall(parent: Document): void {
    new terminalKit.Text({
      attr: themedAttr(
        { bold: true, color: "yellow" },
        { bold: true, color: "white" },
      ),
      content: [
        "Agent Island",
        "",
        `Terminal is ${terminal.width}×${terminal.height}.`,
        "Resize to at least 60×16.",
        "",
        "Press q to quit.",
      ],
      parent,
      x: 2,
      y: 1,
    });
  }

  function updateWidgets(): void {
    if (!widgets) return;
    let nextRendered = renderedContent();
    if (
      nextRendered.header !== rendered.header ||
      nextRendered.headerAttr !== rendered.headerAttr
    ) {
      widgets.header.attr = headerAttr();
      widgets.header.setContent?.(nextRendered.header);
    }
    if (nextRendered.heading !== rendered.heading)
      widgets.detailHeading.setContent?.(nextRendered.heading);
    if (nextRendered.detail !== rendered.detail) {
      widgets.detail.setContent(nextRendered.detail);
      if (state.follow && state.detailView === "activity")
        widgets.detail.scrollToBottom();
      else widgets.detail.scrollTo(null, state.detailScrollY);
    }
    if (
      nextRendered.footer !== rendered.footer ||
      nextRendered.footerAttr !== rendered.footerAttr
    ) {
      widgets.footer.attr = footerAttr();
      widgets.footer.setContent?.(nextRendered.footer);
    }
    if (
      focusPane === "roster" &&
      state.selectedId &&
      state.selectedId !== rendered.selectedId
    )
      widgets.roster.focusValue(state.selectedId, "select", true);
    rendered = nextRendered;
    terminal.hideCursor(true);
  }

  function renderedContent() {
    return {
      detail: detailText(
        state.selectedSeat,
        state.detailView,
        state.selectedLog?.entries ?? null,
        state.query,
      ),
      footer: footerText(),
      footerAttr: JSON.stringify(footerAttr()),
      header: headerText(state.snapshot).padEnd(terminal.width),
      headerAttr: JSON.stringify(headerAttr()),
      heading: seatHeading(state.selectedSeat),
      selectedId: state.selectedId,
    };
  }

  function switchPaneFocus(): void {
    if (!document || !widgets) return;
    focusPane = nextFocusPane(focusPane);
    if (focusPane === "detail") {
      document.giveFocusTo(widgets.detail);
      terminal.hideCursor(true);
      return;
    }
    if (state.selectedId)
      widgets.roster.focusValue(state.selectedId, "select", true);
    else document.giveFocusTo(widgets.roster);
    terminal.hideCursor(true);
  }

  function screenLayoutSignature(): string {
    let seats = state.visibleSeats
      .map((seat) => `${seat.id}:${seat.state}`)
      .join("|");
    return `${terminal.width}x${terminal.height}:${state.detailView}:${seats}`;
  }

  function footerText(): string {
    let notice =
      state.notice && state.notice.until > Date.now()
        ? ` ${state.notice.text}`
        : null;
    let find = state.query ? ` · find:${state.query}` : "";
    return (
      notice ??
      ` [/] Find  [M] ${state.detailView === "memory" ? "Activity" : "Memory"}  [G] Tail  [F] ${state.filter}  [Tab] Focus  [?] Help  [Q] Quit${find}`
    ).padEnd(terminal.width);
  }

  function headerAttr(): Record<string, unknown> {
    return themedAttr(
      {
        bgColor: state.snapshot?.online ? "blue" : "brightBlack",
        bold: true,
        color: "brightWhite",
      },
      { bgColor: "black", bold: true, color: "white" },
    );
  }

  function footerAttr(): Record<string, unknown> {
    let error =
      state.notice?.kind === "error" && state.notice.until > Date.now();
    return themedAttr(
      {
        bgColor: error ? "red" : "brightBlack",
        color: "brightWhite",
      },
      { bgColor: "black", bold: error, color: "white" },
    );
  }

  function themedAttr(
    colored: Record<string, unknown>,
    plain: Record<string, unknown>,
  ): Record<string, unknown> {
    return monochrome ? plain : colored;
  }

  function runHandler(operation: () => Promise<void>): void {
    try {
      void operation().catch(handlers.reportError);
    } catch (error) {
      handlers.reportError(error);
    }
  }

  function handleKey(key: string): void {
    if (key === "CTRL_C" || (!modalOpen && key.toLowerCase() === "q")) {
      handlers.quit();
      return;
    }
    if (modalOpen) return;
    if (key === "TAB" || key === "SHIFT_TAB") switchPaneFocus();
    else if (key === "/") runHandler(handlers.find);
    else if (key === "m") handlers.toggleDetail();
    else if (key === "f") handlers.cycleFilter();
    else if (key === "G") handlers.tail();
    else if (key === "r") runHandler(handlers.refresh);
    else if (key === "?") runHandler(handlers.help);
  }

  return {
    getDocument,
    getTerminal,
    setModal,
    start,
    stop,
    tail,
    update,
  };
}
