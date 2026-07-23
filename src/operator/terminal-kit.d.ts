declare module "terminal-kit" {
  export interface Terminal {
    width: number;
    height: number;
    clear(): Terminal;
    fullscreen(enabled: boolean): Terminal;
    grabInput(options: false | { mouse?: string }): Terminal;
    hideCursor(hidden?: boolean): Terminal;
    styleReset(): Terminal;
    createDocument(options?: Record<string, unknown>): Document;
    on(event: string, listener: (...arguments_: any[]) => void): Terminal;
    off(event: string, listener: (...arguments_: any[]) => void): Terminal;
  }

  export interface Element {
    attr?: Record<string, unknown>;
    destroyed?: boolean;
    hidden?: boolean;
    value?: unknown;
    on(event: string, listener: (...arguments_: any[]) => void): Element;
    destroy(noDraw?: boolean, noRedraw?: boolean): void;
    outerDraw(): void;
    draw(): void;
    setContent?(
      content: string | string[],
      hasMarkup?: boolean | string,
      noDraw?: boolean,
    ): void;
    setAttr?(
      attr?: Record<string, unknown>,
      voidAttr?: Record<string, unknown>,
      dontDraw?: boolean,
      dontSetContent?: boolean,
    ): void;
  }

  export interface Document extends Element {
    elements: Record<string, Element>;
    focusElement: Element | null;
    giveFocusTo(element: Element, type?: string): void;
    focusNext(): void;
  }

  export interface TextBoxElement extends Element {
    scrollY: number;
    setContent(
      content: string | string[],
      hasMarkup?: boolean | string,
      noDraw?: boolean,
    ): void;
    scrollToBottom(noDraw?: boolean): void;
    scrollToTop(noDraw?: boolean): void;
    scrollTo(
      positionX: number | null,
      positionY: number | null,
      noDraw?: boolean,
    ): void;
  }

  export interface MenuElement extends Element {
    focusValue(value: unknown, type?: string, forceInitPage?: boolean): void;
  }

  export interface EditableTextBoxElement extends TextBoxElement {
    setValue(value: string, noDraw?: boolean): void;
    getValue(): string;
  }

  export interface Constructor<T extends Element = Element> {
    new (options: Record<string, unknown>): T;
  }

  export interface TerminalKit {
    terminal: Terminal;
    Text: Constructor;
    Button: Constructor;
    ColumnMenu: Constructor<MenuElement>;
    TextBox: Constructor<TextBoxElement>;
    EditableTextBox: Constructor<EditableTextBoxElement>;
    Window: Constructor;
    Form: Constructor;
  }

  let terminalKit: TerminalKit;
  export default terminalKit;
}
