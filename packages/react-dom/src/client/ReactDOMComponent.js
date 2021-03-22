/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {registrationNameModules} from 'legacy-events/EventPluginRegistry';
import {canUseDOM} from 'shared/ExecutionEnvironment';
import endsWith from 'shared/endsWith';
import {setListenToResponderEventTypes} from '../events/DeprecatedDOMEventResponderSystem';

import {
  getValueForAttribute,
  getValueForProperty,
  setValueForProperty,
} from './DOMPropertyOperations';
import {
  initWrapperState as ReactDOMInputInitWrapperState,
  getHostProps as ReactDOMInputGetHostProps,
  postMountWrapper as ReactDOMInputPostMountWrapper,
  updateChecked as ReactDOMInputUpdateChecked,
  updateWrapper as ReactDOMInputUpdateWrapper,
  restoreControlledState as ReactDOMInputRestoreControlledState,
} from './ReactDOMInput';
import {
  getHostProps as ReactDOMOptionGetHostProps,
  postMountWrapper as ReactDOMOptionPostMountWrapper,
  validateProps as ReactDOMOptionValidateProps,
} from './ReactDOMOption';
import {
  initWrapperState as ReactDOMSelectInitWrapperState,
  getHostProps as ReactDOMSelectGetHostProps,
  postMountWrapper as ReactDOMSelectPostMountWrapper,
  restoreControlledState as ReactDOMSelectRestoreControlledState,
  postUpdateWrapper as ReactDOMSelectPostUpdateWrapper,
} from './ReactDOMSelect';
import {
  initWrapperState as ReactDOMTextareaInitWrapperState,
  getHostProps as ReactDOMTextareaGetHostProps,
  postMountWrapper as ReactDOMTextareaPostMountWrapper,
  updateWrapper as ReactDOMTextareaUpdateWrapper,
  restoreControlledState as ReactDOMTextareaRestoreControlledState,
} from './ReactDOMTextarea';
import {track} from './inputValueTracking';
import setInnerHTML from './setInnerHTML';
import setTextContent from './setTextContent';
import {
  TOP_ERROR,
  TOP_INVALID,
  TOP_LOAD,
  TOP_RESET,
  TOP_SUBMIT,
  TOP_TOGGLE,
} from '../events/DOMTopLevelEventTypes';
import {getListenerMapForElement} from '../events/DOMEventListenerMap';
import {
  addResponderEventSystemEvent,
  removeActiveResponderEventSystemEvent,
  trapBubbledEvent,
} from '../events/ReactDOMEventListener.js';
import {mediaEventTypes} from '../events/DOMTopLevelEventTypes';
import {
  createDangerousStringForStyles,
  setValueForStyles,
  validateShorthandPropertyCollisionInDev,
} from '../shared/CSSPropertyOperations';
import {Namespaces, getIntrinsicNamespace} from '../shared/DOMNamespaces';
import {
  getPropertyInfo,
  shouldIgnoreAttribute,
  shouldRemoveAttribute,
} from '../shared/DOMProperty';
import assertValidProps from '../shared/assertValidProps';
import {DOCUMENT_NODE, DOCUMENT_FRAGMENT_NODE} from '../shared/HTMLNodeType';
import isCustomComponent from '../shared/isCustomComponent';
import possibleStandardNames from '../shared/possibleStandardNames';
import {validateProperties as validateARIAProperties} from '../shared/ReactDOMInvalidARIAHook';
import {validateProperties as validateInputProperties} from '../shared/ReactDOMNullInputValuePropHook';
import {validateProperties as validateUnknownProperties} from '../shared/ReactDOMUnknownPropertyHook';

import {
  enableDeprecatedFlareAPI,
  enableTrustedTypesIntegration,
} from 'shared/ReactFeatureFlags';
import {legacyListenToEvent} from '../events/DOMLegacyEventPluginSystem';

let didWarnInvalidHydration = false;
let didWarnScriptTags = false;

const DANGEROUSLY_SET_INNER_HTML = 'dangerouslySetInnerHTML';
const SUPPRESS_CONTENT_EDITABLE_WARNING = 'suppressContentEditableWarning';
const SUPPRESS_HYDRATION_WARNING = 'suppressHydrationWarning';
const AUTOFOCUS = 'autoFocus';
const CHILDREN = 'children';
const STYLE = 'style';
const HTML = '__html';
const DEPRECATED_flareListeners = 'DEPRECATED_flareListeners';

const {html: HTML_NAMESPACE} = Namespaces;

let warnedUnknownTags;
let suppressHydrationWarning;

let validatePropertiesInDevelopment;
let warnForTextDifference;
let warnForPropDifference;
let warnForExtraAttributes;
let warnForInvalidEventListener;
let canDiffStyleForHydrationWarning;

let normalizeMarkupForTextOrAttribute;
let normalizeHTML;

if (__DEV__) {
  warnedUnknownTags = {
    // Chrome is the only major browser not shipping <time>. But as of July
    // 2017 it intends to ship it due to widespread usage. We intentionally
    // *don't* warn for <time> even if it's unrecognized by Chrome because
    // it soon will be, and many apps have been using it anyway.
    time: true,
    // There are working polyfills for <dialog>. Let people use it.
    dialog: true,
    // Electron ships a custom <webview> tag to display external web content in
    // an isolated frame and process.
    // This tag is not present in non Electron environments such as JSDom which
    // is often used for testing purposes.
    // @see https://electronjs.org/docs/api/webview-tag
    webview: true,
  };

  validatePropertiesInDevelopment = function(type, props) {
    validateARIAProperties(type, props);
    validateInputProperties(type, props);
    validateUnknownProperties(type, props, /* canUseEventSystem */ true);
  };

  // IE 11 parses & normalizes the style attribute as opposed to other
  // browsers. It adds spaces and sorts the properties in some
  // non-alphabetical order. Handling that would require sorting CSS
  // properties in the client & server versions or applying
  // `expectedStyle` to a temporary DOM node to read its `style` attribute
  // normalized. Since it only affects IE, we're skipping style warnings
  // in that browser completely in favor of doing all that work.
  // See https://github.com/facebook/react/issues/11807
  canDiffStyleForHydrationWarning = canUseDOM && !document.documentMode;

  // HTML parsing normalizes CR and CRLF to LF.
  // It also can turn \u0000 into \uFFFD inside attributes.
  // https://www.w3.org/TR/html5/single-page.html#preprocessing-the-input-stream
  // If we have a mismatch, it might be caused by that.
  // We will still patch up in this case but not fire the warning.
  const NORMALIZE_NEWLINES_REGEX = /\r\n?/g;
  const NORMALIZE_NULL_AND_REPLACEMENT_REGEX = /\u0000|\uFFFD/g;

  normalizeMarkupForTextOrAttribute = function(markup: mixed): string {
    const markupString =
      typeof markup === 'string' ? markup : '' + (markup: any);
    return markupString
      .replace(NORMALIZE_NEWLINES_REGEX, '\n')
      .replace(NORMALIZE_NULL_AND_REPLACEMENT_REGEX, '');
  };

  warnForTextDifference = function(
    serverText: string,
    clientText: string | number,
  ) {
    if (didWarnInvalidHydration) {
      return;
    }
    const normalizedClientText = normalizeMarkupForTextOrAttribute(clientText);
    const normalizedServerText = normalizeMarkupForTextOrAttribute(serverText);
    if (normalizedServerText === normalizedClientText) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Text content did not match. Server: "%s" Client: "%s"',
      normalizedServerText,
      normalizedClientText,
    );
  };

  warnForPropDifference = function(
    propName: string,
    serverValue: mixed,
    clientValue: mixed,
  ) {
    if (didWarnInvalidHydration) {
      return;
    }
    const normalizedClientValue = normalizeMarkupForTextOrAttribute(
      clientValue,
    );
    const normalizedServerValue = normalizeMarkupForTextOrAttribute(
      serverValue,
    );
    if (normalizedServerValue === normalizedClientValue) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Prop `%s` did not match. Server: %s Client: %s',
      propName,
      JSON.stringify(normalizedServerValue),
      JSON.stringify(normalizedClientValue),
    );
  };

  warnForExtraAttributes = function(attributeNames: Set<string>) {
    if (didWarnInvalidHydration) {
      return;
    }
    didWarnInvalidHydration = true;
    const names = [];
    attributeNames.forEach(function(name) {
      names.push(name);
    });
    console.error('Extra attributes from the server: %s', names);
  };

  warnForInvalidEventListener = function(registrationName, listener) {
    if (listener === false) {
      console.error(
        'Expected `%s` listener to be a function, instead got `false`.\n\n' +
          'If you used to conditionally omit it with %s={condition && value}, ' +
          'pass %s={condition ? value : undefined} instead.',
        registrationName,
        registrationName,
        registrationName,
      );
    } else {
      console.error(
        'Expected `%s` listener to be a function, instead got a value of `%s` type.',
        registrationName,
        typeof listener,
      );
    }
  };

  // Parse the HTML and read it back to normalize the HTML string so that it
  // can be used for comparison.
  normalizeHTML = function(parent: Element, html: string) {
    // We could have created a separate document here to avoid
    // re-initializing custom elements if they exist. But this breaks
    // how <noscript> is being handled. So we use the same document.
    // See the discussion in https://github.com/facebook/react/pull/11157.
    const testElement =
      parent.namespaceURI === HTML_NAMESPACE
        ? parent.ownerDocument.createElement(parent.tagName)
        : parent.ownerDocument.createElementNS(
            (parent.namespaceURI: any),
            parent.tagName,
          );
    testElement.innerHTML = html;
    return testElement.innerHTML;
  };
}

function ensureListeningTo(
  rootContainerElement: Element | Node,
  registrationName: string,
): void {
  const isDocumentOrFragment =
    rootContainerElement.nodeType === DOCUMENT_NODE ||
    rootContainerElement.nodeType === DOCUMENT_FRAGMENT_NODE;
  const doc = isDocumentOrFragment
    ? rootContainerElement
    : rootContainerElement.ownerDocument;
  legacyListenToEvent(registrationName, doc);
}

function getOwnerDocumentFromRootContainer(
  rootContainerElement: Element | Document,
): Document {
  return rootContainerElement.nodeType === DOCUMENT_NODE
    ? (rootContainerElement: any)
    : rootContainerElement.ownerDocument;
}

function noop() {}

export function trapClickOnNonInteractiveElement(node: HTMLElement) {
  // Mobile Safari does not fire properly bubble click events on
  // non-interactive elements, which means delegated click listeners do not
  // fire. The workaround for this bug involves attaching an empty click
  // listener on the target node.
  // http://www.quirksmode.org/blog/archives/2010/09/click_event_del.html
  // Just set it using the onclick property so that we don't have to manage any
  // bookkeeping for it. Not sure if we need to clear it when the listener is
  // removed.
  // TODO: Only do this for the relevant Safaris maybe?
  node.onclick = noop;
}

// 初始化 DOM 对象的内部属性，如 style,dangersouslySetInnerHTML,children 特殊处理
function setInitialDOMProperties(
  tag: string,
  domElement: Element,
  rootContainerElement: Element | Document,
  nextProps: Object,
  isCustomComponentTag: boolean,
): void {
  // 循环 nextProps
  for (const propKey in nextProps) {
    // 原型链上的属性不作处理
    if (!nextProps.hasOwnProperty(propKey)) {
      continue;
    }
    // 获取 prop 的值
    const nextProp = nextProps[propKey];
    if (propKey === STYLE) {
      // 设置 style 属性
      if (__DEV__) {
        if (nextProp) {
          // Freeze the next style object so that we can assume it won't be
          // mutated. We have already warned for this in the past.
          Object.freeze(nextProp);
        }
      }
      // Relies on `updateStylesByID` not mutating `styleUpdates`.
      setValueForStyles(domElement, nextProp);
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      // 设置 dangerouslySetInnerHTML 属性
      const nextHtml = nextProp ? nextProp[HTML] : undefined;
      if (nextHtml != null) {
        setInnerHTML(domElement, nextHtml);
      }
    } else if (propKey === CHILDREN) {
      // 设置子节点
      if (typeof nextProp === 'string') {
        // Avoid setting initial textContent when the text is empty. In IE11 setting
        // textContent on a <textarea> will cause the placeholder to not
        // show within the <textarea> until it has been focused and blurred again.
        // https://github.com/facebook/react/issues/6731#issuecomment-254874553
        const canSetTextContent = tag !== 'textarea' || nextProp !== '';
        // 当 text 有内容时，初始化
        if (canSetTextContent) {
          setTextContent(domElement, nextProp);
        }
      } else if (typeof nextProp === 'number') {
        // number 的话转成 string
        setTextContent(domElement, '' + nextProp);
      }
    } else if (
      (enableDeprecatedFlareAPI && propKey === DEPRECATED_flareListeners) ||
      propKey === SUPPRESS_CONTENT_EDITABLE_WARNING ||
      propKey === SUPPRESS_HYDRATION_WARNING
    ) {
      // Noop
    } else if (propKey === AUTOFOCUS) {
      // We polyfill it separately on the client during commit.
      // We could have excluded it in the property list instead of
      // adding a special case here, but then it wouldn't be emitted
      // on server rendering (but we *do* want to emit it in SSR).
    } else if (registrationNameModules.hasOwnProperty(propKey)) {
      // 如果有绑定事件的话，如<div onClick=(()=>{ xxx })></div>
      if (nextProp != null) {
        if (__DEV__ && typeof nextProp !== 'function') {
          warnForInvalidEventListener(propKey, nextProp);
        }
        ensureListeningTo(rootContainerElement, propKey);
      }
    } else if (nextProp != null) {
      // 为 DOM 节点设置属性值
      setValueForProperty(domElement, propKey, nextProp, isCustomComponentTag);
    }
  }
}

function updateDOMProperties(
  domElement: Element,
  updatePayload: Array<any>,
  wasCustomComponentTag: boolean,
  isCustomComponentTag: boolean,
): void {
  // TODO: Handle wasCustomComponentTag
  for (let i = 0; i < updatePayload.length; i += 2) {
    const propKey = updatePayload[i];
    const propValue = updatePayload[i + 1];
    if (propKey === STYLE) {
      setValueForStyles(domElement, propValue);
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      setInnerHTML(domElement, propValue);
    } else if (propKey === CHILDREN) {
      setTextContent(domElement, propValue);
    } else {
      setValueForProperty(domElement, propKey, propValue, isCustomComponentTag);
    }
  }
}

/**
 * 创建 DOM 元素
 */
export function createElement(
  type: string,
  props: Object,
  rootContainerElement: Element | Document,
  parentNamespace: string,
): Element {
  let isCustomComponentTag;

  // We create tags in the namespace of their parent container, except HTML
  // tags get no namespace.
  // 获取 document 对象
  const ownerDocument: Document = getOwnerDocumentFromRootContainer(
    rootContainerElement,
  );
  let domElement: Element;
  let namespaceURI = parentNamespace;
  if (namespaceURI === HTML_NAMESPACE) {
    // 根据 DOM 实例的标签获取相应的命名空间
    namespaceURI = getIntrinsicNamespace(type);
  }
  // 如果是 html namespace
  if (namespaceURI === HTML_NAMESPACE) {
    if (__DEV__) {
      isCustomComponentTag = isCustomComponent(type, props);
      // Should this check be gated by parent namespace? Not sure we want to
      // allow <SVG> or <mATH>.
      if (!isCustomComponentTag && type !== type.toLowerCase()) {
        console.error(
          '<%s /> is using incorrect casing. ' +
            'Use PascalCase for React components, ' +
            'or lowercase for HTML elements.',
          type,
        );
      }
    }

    if (type === 'script') {
      // Create the script via .innerHTML so its "parser-inserted" flag is
      // set to true and it does not execute
      const div = ownerDocument.createElement('div');
      if (__DEV__) {
        if (enableTrustedTypesIntegration && !didWarnScriptTags) {
          console.error(
            'Encountered a script tag while rendering React component. ' +
              'Scripts inside React components are never executed when rendering ' +
              'on the client. Consider using template tag instead ' +
              '(https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template).',
          );
          didWarnScriptTags = true;
        }
      }
      div.innerHTML = '<script><' + '/script>'; // eslint-disable-line
      // This is guaranteed to yield a script element.
      const firstChild = ((div.firstChild: any): HTMLScriptElement);
      domElement = div.removeChild(firstChild);
    } else if (typeof props.is === 'string') {
      // 如果需要更新的 props 里有 is 属性的话，那么创建该元素时，则为它添加「is」attribute
      // $FlowIssue `createElement` should be updated for Web Components
      domElement = ownerDocument.createElement(type, {is: props.is});
    } else {
      // Separate else branch instead of using `props.is || undefined` above because of a Firefox bug.
      // See discussion in https://github.com/facebook/react/pull/6896
      // and discussion in https://bugzilla.mozilla.org/show_bug.cgi?id=1276240
      // 因为 Firefox 的一个 bug，所以需要特殊处理「is」属性
      domElement = ownerDocument.createElement(type);
      // Normally attributes are assigned in `setInitialDOMProperties`, however the `multiple` and `size`
      // attributes on `select`s needs to be added before `option`s are inserted.
      // This prevents:
      // - a bug where the `select` does not scroll to the correct option because singular
      //  `select` elements automatically pick the first item #13222
      // - a bug where the `select` set the first item as selected despite the `size` attribute #14239
      // See https://github.com/facebook/react/issues/13222
      // and https://github.com/facebook/react/issues/14239
      if (type === 'select') {
        // <select>标签需要在<option>子节点被插入之前，设置`multiple`和`size`属性
        const node = ((domElement: any): HTMLSelectElement);
        if (props.multiple) {
          node.multiple = true;
        } else if (props.size) {
          // Setting a size greater than 1 causes a select to behave like `multiple=true`, where
          // it is possible that no option is selected.
          //
          // This is only necessary when a select in "single selection mode".
          node.size = props.size;
        }
      }
    }
  } else {
    // SVG,MathML 的元素创建是需要指定命名空间 URI 的
    // 创建一个具有指定的命名空间URI和限定名称的元素
    // https://developer.mozilla.org/zh-CN/docs/Web/API/Document/createElementNS
    domElement = ownerDocument.createElementNS(namespaceURI, type);
  }

  if (__DEV__) {
    if (namespaceURI === HTML_NAMESPACE) {
      if (
        !isCustomComponentTag &&
        Object.prototype.toString.call(domElement) ===
          '[object HTMLUnknownElement]' &&
        !Object.prototype.hasOwnProperty.call(warnedUnknownTags, type)
      ) {
        warnedUnknownTags[type] = true;
        console.error(
          'The tag <%s> is unrecognized in this browser. ' +
            'If you meant to render a React component, start its name with ' +
            'an uppercase letter.',
          type,
        );
      }
    }
  }

  return domElement;
}

export function createTextNode(
  text: string,
  rootContainerElement: Element | Document,
): Text {
  return getOwnerDocumentFromRootContainer(rootContainerElement).createTextNode(
    text,
  );
}

/**
 * 初始化DOM 对象
 * 1、对一些标签进行事件绑定/属性的特殊处理
 * 2、对 DOM 对象内部属性进行初始化
 */
export function setInitialProperties(
  domElement: Element,
  tag: string,
  rawProps: Object,
  rootContainerElement: Element | Document,
): void {
  // 判断是否是自定义的 DOM 标签
  const isCustomComponentTag = isCustomComponent(tag, rawProps);
  if (__DEV__) {
    validatePropertiesInDevelopment(tag, rawProps);
  }

  // TODO: Make sure that we check isMounted before firing any of these events.
  // 确保在触发这些监听器触发之间，已经初始化了 event
  let props: Object;
  switch (tag) {
    case 'iframe':
    case 'object':
    case 'embed':
      // React 自定义的绑定事件，暂时跳过
      trapBubbledEvent(TOP_LOAD, domElement);
      props = rawProps;
      break;
    case 'video':
    case 'audio':
      // Create listener for each media event
      // 初始化 media 标签的监听器
      for (let i = 0; i < mediaEventTypes.length; i++) {
        trapBubbledEvent(mediaEventTypes[i], domElement);
      }
      props = rawProps;
      break;
    case 'source':
      trapBubbledEvent(TOP_ERROR, domElement);
      props = rawProps;
      break;
    case 'img':
    case 'image':
    case 'link':
      trapBubbledEvent(TOP_ERROR, domElement);
      trapBubbledEvent(TOP_LOAD, domElement);
      props = rawProps;
      break;
    case 'form':
      trapBubbledEvent(TOP_RESET, domElement);
      trapBubbledEvent(TOP_SUBMIT, domElement);
      props = rawProps;
      break;
    case 'details':
      trapBubbledEvent(TOP_TOGGLE, domElement);
      props = rawProps;
      break;
    case 'input':
      ReactDOMInputInitWrapperState(domElement, rawProps);
      props = ReactDOMInputGetHostProps(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
    case 'option':
      ReactDOMOptionValidateProps(domElement, rawProps);
      props = ReactDOMOptionGetHostProps(domElement, rawProps);
      break;
    case 'select':
      ReactDOMSelectInitWrapperState(domElement, rawProps);
      props = ReactDOMSelectGetHostProps(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
    case 'textarea':
      ReactDOMTextareaInitWrapperState(domElement, rawProps);
      props = ReactDOMTextareaGetHostProps(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
    default:
      props = rawProps;
  }

  assertValidProps(tag, props);

  // 初始化 DOM 对象的内部属性
  setInitialDOMProperties(
    tag,
    domElement,
    rootContainerElement,
    props,
    isCustomComponentTag,
  );

  switch (tag) {
    case 'input':
      // TODO: Make sure we check if this is still unmounted or do any clean
      // up necessary since we never stop tracking anymore.
      track((domElement: any));
      ReactDOMInputPostMountWrapper(domElement, rawProps, false);
      break;
    case 'textarea':
      // TODO: Make sure we check if this is still unmounted or do any clean
      // up necessary since we never stop tracking anymore.
      track((domElement: any));
      ReactDOMTextareaPostMountWrapper(domElement, rawProps);
      break;
    case 'option':
      ReactDOMOptionPostMountWrapper(domElement, rawProps);
      break;
    case 'select':
      ReactDOMSelectPostMountWrapper(domElement, rawProps);
      break;
    default:
      if (typeof props.onClick === 'function') {
        // TODO: This cast may not be sound for SVG, MathML or custom elements.
        trapClickOnNonInteractiveElement(((domElement: any): HTMLElement));
      }
      break;
  }
}

// Calculate the diff between the two objects.
/**
 * diff算法
 * 计算出新老 props 的差异
 * 步骤：
 *  1、根据不同标签节点提取新老 props 准备比较
 *  2、第一次遍历老 props 把要删除的属性都设置为 null
 *  3、第二次遍历新 props , 把新的props push 到updatePayload
 *  4、最后生成updatePayload: [k1,null,k2,v2,k3,v3]
 * @param {*} domElement
 * @param {*} tag
 * @param {*} lastRawProps
 * @param {*} nextRawProps
 * @param {*} rootContainerElement
 * @returns
 */
export function diffProperties(
  domElement: Element,
  tag: string,
  lastRawProps: Object,
  nextRawProps: Object,
  rootContainerElement: Element | Document,
): null | Array<mixed> {
  if (__DEV__) {
    validatePropertiesInDevelopment(tag, nextRawProps);
  }

  // 需要更新的 props 集合
  let updatePayload: null | Array<any> = null;

  // old props
  let lastProps: Object;
  // new props
  let nextProps: Object;
  // 1、根据不同标签节点提取新老 props 准备比较
  switch (tag) {
    case 'input':
      lastProps = ReactDOMInputGetHostProps(domElement, lastRawProps);
      nextProps = ReactDOMInputGetHostProps(domElement, nextRawProps);
      updatePayload = [];
      break;
    case 'option':
      lastProps = ReactDOMOptionGetHostProps(domElement, lastRawProps);
      nextProps = ReactDOMOptionGetHostProps(domElement, nextRawProps);
      updatePayload = [];
      break;
    case 'select':
      lastProps = ReactDOMSelectGetHostProps(domElement, lastRawProps);
      nextProps = ReactDOMSelectGetHostProps(domElement, nextRawProps);
      updatePayload = [];
      break;
    case 'textarea':
      lastProps = ReactDOMTextareaGetHostProps(domElement, lastRawProps);
      nextProps = ReactDOMTextareaGetHostProps(domElement, nextRawProps);
      updatePayload = [];
      break;
    default:
      lastProps = lastRawProps;
      nextProps = nextRawProps;
      // 如果需要更新绑定 click 方法的话
      if (
        typeof lastProps.onClick !== 'function' &&
        typeof nextProps.onClick === 'function'
      ) {
        // TODO: This cast may not be sound for SVG, MathML or custom elements.
        // 初始化 onclick 事件，以便兼容Safari移动端
        trapClickOnNonInteractiveElement(((domElement: any): HTMLElement));
      }
      break;
  }

  // 断言，判断新属性，比如 style 是否正确赋值
  assertValidProps(tag, nextProps);

  // 2、第一次遍历老 props 把要删除的属性都设置为 null
  let propKey;
  let styleName;
  let styleUpdates = null;
  // 循环操作老 props 中的属性
  // 将删除 props 加入到数组中
  for (propKey in lastProps) {
    if (
      nextProps.hasOwnProperty(propKey) || // 如果新 props 上有该属性的话
      !lastProps.hasOwnProperty(propKey) || // 或者老 props 没有该属性的话（即原型链上的属性，比如：toString() ）
      lastProps[propKey] == null // 或者老 props 的值为 'null' 的话
    ) {
      // 跳过此次循环，也就是说不跳过此次循环的条件是该 if 为 false
      // 新 props 没有该属性并且在老 props 上有该属性并且该属性不为 'null'/null
      // 也就是说，能继续执行下面的代码的前提是：propKey 是删除的属性
      continue;
    }
    // 能执行到这边，说明 propKey 是新增属性
    // 对 style 属性进行操作，<div style={{height:30,}}></div>
    if (propKey === STYLE) {
      // 获取老的 style 属性对象
      const lastStyle = lastProps[propKey];
      // 遍历老 style 属性，如：height
      for (styleName in lastStyle) {
        // 如果老 style 中本来就有 styleName 的话,则将其重置为''
        if (lastStyle.hasOwnProperty(styleName)) {
          if (!styleUpdates) {
            styleUpdates = {};
          }
          // 重置(初始化)
          styleUpdates[styleName] = '';
        }
      }
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML || propKey === CHILDREN) {
      // Noop. This is handled by the clear text mechanism.
    } else if (
      (enableDeprecatedFlareAPI && propKey === DEPRECATED_flareListeners) ||
      propKey === SUPPRESS_CONTENT_EDITABLE_WARNING ||
      propKey === SUPPRESS_HYDRATION_WARNING
    ) {
      // Noop
    } else if (propKey === AUTOFOCUS) {
      // Noop. It doesn't work on updates anyway.
    } else if (registrationNameModules.hasOwnProperty(propKey)) {
      // This is a special case. If any listener updates we need to ensure
      // that the "current" fiber pointer gets updated so we need a commit
      // to update this element.
      if (!updatePayload) {
        updatePayload = [];
      }
    } else {
      // For all other deleted properties we add it to the queue. We use
      // the whitelist in the commit phase instead.
      // 将不符合以上条件的删除属性 propKey push 进 updatePayload 中.如：['className']
      (updatePayload = updatePayload || []).push(propKey, null);
    }
  }
  // 3、第二次遍历新 props , 把新的props push 到updatePayload
  for (propKey in nextProps) {
    // 获取新 prop 的值
    const nextProp = nextProps[propKey];
    // 获取老 prop 的值（因为是根据新 props 遍历的，所以老 props 没有则为 undefined）
    const lastProp = lastProps != null ? lastProps[propKey] : undefined;
    if (
      !nextProps.hasOwnProperty(propKey) || // 如果新 props 没有该 propKey 的话（ 比如原型链上的属性，toString() ）
      nextProp === lastProp || // 或者新 value 等于老 value 的话（即没有更新）
      (nextProp == null && lastProp == null) // 或者新老 value 均「宽松等于」 null 的话（'null'还有其他情况吗？）（即：没有更新）
    ) {
      // 不往下执行
      // 也就是说往下执行的条件是：新 props 有该 propKey 并且新老 value 不为 null 且不相等
      // 即有更新的情况
      continue;
    }
    // 能执行到这边，说明新 prop 的值与老 prop 的值不相同/新增 prop 并且有值
    // 关于 style 属性的更新 <input style={{xxx:yyy}}/>
    if (propKey === STYLE) {
      if (__DEV__) {
        if (nextProp) {
          // Freeze the next style object so that we can assume it won't be
          // mutated. We have already warned for this in the past.
          Object.freeze(nextProp);
        }
      }

      // 如果老 props 本来就有这个 prop 的话
      if (lastProp) {
        // Unset styles on `lastProp` but not on `nextProp`.
        // 如果新 style 没有该 css 的话,将其置为''（也就是删掉该 css 属性）
        for (styleName in lastProp) {
          if (
            lastProp.hasOwnProperty(styleName) &&
            (!nextProp || !nextProp.hasOwnProperty(styleName))
          ) {
            if (!styleUpdates) {
              styleUpdates = {};
            }
            // 将其置为''
            styleUpdates[styleName] = '';
          }
        }
        // Update styles that changed since `lastProp`.
        // 这里才是更新 style 属性
        for (styleName in nextProp) {
          if (
            // 新 props 有 style 并且与老 props 不一样的话，就更新 style 属性
            nextProp.hasOwnProperty(styleName) &&
            lastProp[styleName] !== nextProp[styleName]
          ) {
            if (!styleUpdates) {
              styleUpdates = {};
            }
            // 更新 style
            // 更新统一放在 styleUpdates 对象中
            styleUpdates[styleName] = nextProp[styleName];
          }
        }
      } else {
        // 如果不是更新的 style 而是新增的话
        // Relies on `updateStylesByID` not mutating `styleUpdates`.

        // 第一次初始化
        if (!styleUpdates) {
          if (!updatePayload) {
            updatePayload = [];
          }
          // 将 'style'、null push 进数组 updatePayload 中
          // ['style',null]
          updatePayload.push(propKey, styleUpdates);
        }
        // styleUpdates 赋成新 style 的值
        styleUpdates = nextProp;
      }
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      // __html
      // 新 innerHTML
      const nextHtml = nextProp ? nextProp[HTML] : undefined;
      // 老 innerHTML
      const lastHtml = lastProp ? lastProp[HTML] : undefined;
      // push('__html','xxxxx')
      if (nextHtml != null) {
        if (lastHtml !== nextHtml) {
          (updatePayload = updatePayload || []).push(propKey, nextHtml);
        }
      } else {
        // TODO: It might be too late to clear this if we have children
        // inserted already.
      }
    } else if (propKey === CHILDREN) {
      // 子节点的更新
      if (
        lastProp !== nextProp &&
        // 子节点是文本节点或数字
        (typeof nextProp === 'string' || typeof nextProp === 'number')
      ) {
        // push 进数组中
        (updatePayload = updatePayload || []).push(propKey, '' + nextProp);
      }
    } else if (
      (enableDeprecatedFlareAPI && propKey === DEPRECATED_flareListeners) ||
      propKey === SUPPRESS_CONTENT_EDITABLE_WARNING ||
      propKey === SUPPRESS_HYDRATION_WARNING
    ) {
      // Noop
    } else if (registrationNameModules.hasOwnProperty(propKey)) {
      // 如果有绑定事件的话，如<div onClick=(()=>{ xxx })></div>

      // 绑定事件里有回调函数的话
      if (nextProp != null) {
        // We eagerly listen to this even though we haven't committed yet.
        if (__DEV__ && typeof nextProp !== 'function') {
          warnForInvalidEventListener(propKey, nextProp);
        }
        // 找到 document 对象，React 是将节点上绑定的事件统一委托到 document 上的
        // 涉及到event 那块了，暂时跳过
        // 参考https://www.cnblogs.com/Darlietoothpaste/p/10039127.html?utm_source=tuicool&utm_medium=referral
        ensureListeningTo(rootContainerElement, propKey);
      }
      if (!updatePayload && lastProp !== nextProp) {
        // This is a special case. If any listener updates we need to ensure
        // that the "current" props pointer gets updated so we need a commit
        // to update this element.
        // 特殊的情况.
        // 在监听器更新前，React 需要确保当前 props 的指针得到更新，
        // 因此 React 需要一个 commit (即 updatePayload )，确保能更新该节点
        // 因此 updatePayload 要不为 null
        updatePayload = [];
      }
    } else {
      // 不符合以上的需要更新的新 propsKey
      // For any other property we always add it to the queue and then we
      // filter it out using the whitelist during the commit.
      // 将新增的 propsKey push 进 updatePayload

      // 在之后的 commit 阶段，会用白名单筛选出这些 props
      (updatePayload = updatePayload || []).push(propKey, nextProp);
    }
  }
  // 将有关 style 的更新 push 进 updatePayload 中
  if (styleUpdates) {
    if (__DEV__) {
      validateShorthandPropertyCollisionInDev(styleUpdates, nextProps[STYLE]);
    }
    (updatePayload = updatePayload || []).push(STYLE, styleUpdates);
  }
  return updatePayload;
}

// Apply the diff.
export function updateProperties(
  domElement: Element,
  updatePayload: Array<any>,
  tag: string,
  lastRawProps: Object,
  nextRawProps: Object,
): void {
  // Update checked *before* name.
  // In the middle of an update, it is possible to have multiple checked.
  // When a checked radio tries to change name, browser makes another radio's checked false.
  if (
    tag === 'input' &&
    nextRawProps.type === 'radio' &&
    nextRawProps.name != null
  ) {
    ReactDOMInputUpdateChecked(domElement, nextRawProps);
  }

  const wasCustomComponentTag = isCustomComponent(tag, lastRawProps);
  const isCustomComponentTag = isCustomComponent(tag, nextRawProps);
  // Apply the diff.
  updateDOMProperties(
    domElement,
    updatePayload,
    wasCustomComponentTag,
    isCustomComponentTag,
  );

  // TODO: Ensure that an update gets scheduled if any of the special props
  // changed.
  switch (tag) {
    case 'input':
      // Update the wrapper around inputs *after* updating props. This has to
      // happen after `updateDOMProperties`. Otherwise HTML5 input validations
      // raise warnings and prevent the new value from being assigned.
      ReactDOMInputUpdateWrapper(domElement, nextRawProps);
      break;
    case 'textarea':
      ReactDOMTextareaUpdateWrapper(domElement, nextRawProps);
      break;
    case 'select':
      // <select> value update needs to occur after <option> children
      // reconciliation
      ReactDOMSelectPostUpdateWrapper(domElement, nextRawProps);
      break;
  }
}

function getPossibleStandardName(propName: string): string | null {
  if (__DEV__) {
    const lowerCasedName = propName.toLowerCase();
    if (!possibleStandardNames.hasOwnProperty(lowerCasedName)) {
      return null;
    }
    return possibleStandardNames[lowerCasedName] || null;
  }
  return null;
}

export function diffHydratedProperties(
  domElement: Element,
  tag: string,
  rawProps: Object,
  parentNamespace: string,
  rootContainerElement: Element | Document,
): null | Array<mixed> {
  let isCustomComponentTag;
  let extraAttributeNames: Set<string>;

  if (__DEV__) {
    suppressHydrationWarning = rawProps[SUPPRESS_HYDRATION_WARNING] === true;
    isCustomComponentTag = isCustomComponent(tag, rawProps);
    validatePropertiesInDevelopment(tag, rawProps);
  }

  // TODO: Make sure that we check isMounted before firing any of these events.
  switch (tag) {
    case 'iframe':
    case 'object':
    case 'embed':
      trapBubbledEvent(TOP_LOAD, domElement);
      break;
    case 'video':
    case 'audio':
      // Create listener for each media event
      for (let i = 0; i < mediaEventTypes.length; i++) {
        trapBubbledEvent(mediaEventTypes[i], domElement);
      }
      break;
    case 'source':
      trapBubbledEvent(TOP_ERROR, domElement);
      break;
    case 'img':
    case 'image':
    case 'link':
      trapBubbledEvent(TOP_ERROR, domElement);
      trapBubbledEvent(TOP_LOAD, domElement);
      break;
    case 'form':
      trapBubbledEvent(TOP_RESET, domElement);
      trapBubbledEvent(TOP_SUBMIT, domElement);
      break;
    case 'details':
      trapBubbledEvent(TOP_TOGGLE, domElement);
      break;
    case 'input':
      ReactDOMInputInitWrapperState(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
    case 'option':
      ReactDOMOptionValidateProps(domElement, rawProps);
      break;
    case 'select':
      ReactDOMSelectInitWrapperState(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
    case 'textarea':
      ReactDOMTextareaInitWrapperState(domElement, rawProps);
      trapBubbledEvent(TOP_INVALID, domElement);
      // For controlled components we always need to ensure we're listening
      // to onChange. Even if there is no listener.
      ensureListeningTo(rootContainerElement, 'onChange');
      break;
  }

  assertValidProps(tag, rawProps);

  if (__DEV__) {
    extraAttributeNames = new Set();
    const attributes = domElement.attributes;
    for (let i = 0; i < attributes.length; i++) {
      const name = attributes[i].name.toLowerCase();
      switch (name) {
        // Built-in SSR attribute is whitelisted
        case 'data-reactroot':
          break;
        // Controlled attributes are not validated
        // TODO: Only ignore them on controlled tags.
        case 'value':
          break;
        case 'checked':
          break;
        case 'selected':
          break;
        default:
          // Intentionally use the original name.
          // See discussion in https://github.com/facebook/react/pull/10676.
          extraAttributeNames.add(attributes[i].name);
      }
    }
  }

  let updatePayload = null;
  for (const propKey in rawProps) {
    if (!rawProps.hasOwnProperty(propKey)) {
      continue;
    }
    const nextProp = rawProps[propKey];
    if (propKey === CHILDREN) {
      // For text content children we compare against textContent. This
      // might match additional HTML that is hidden when we read it using
      // textContent. E.g. "foo" will match "f<span>oo</span>" but that still
      // satisfies our requirement. Our requirement is not to produce perfect
      // HTML and attributes. Ideally we should preserve structure but it's
      // ok not to if the visible content is still enough to indicate what
      // even listeners these nodes might be wired up to.
      // TODO: Warn if there is more than a single textNode as a child.
      // TODO: Should we use domElement.firstChild.nodeValue to compare?
      if (typeof nextProp === 'string') {
        if (domElement.textContent !== nextProp) {
          if (__DEV__ && !suppressHydrationWarning) {
            warnForTextDifference(domElement.textContent, nextProp);
          }
          updatePayload = [CHILDREN, nextProp];
        }
      } else if (typeof nextProp === 'number') {
        if (domElement.textContent !== '' + nextProp) {
          if (__DEV__ && !suppressHydrationWarning) {
            warnForTextDifference(domElement.textContent, nextProp);
          }
          updatePayload = [CHILDREN, '' + nextProp];
        }
      }
    } else if (registrationNameModules.hasOwnProperty(propKey)) {
      if (nextProp != null) {
        if (__DEV__ && typeof nextProp !== 'function') {
          warnForInvalidEventListener(propKey, nextProp);
        }
        ensureListeningTo(rootContainerElement, propKey);
      }
    } else if (
      __DEV__ &&
      // Convince Flow we've calculated it (it's DEV-only in this method.)
      typeof isCustomComponentTag === 'boolean'
    ) {
      // Validate that the properties correspond to their expected values.
      let serverValue;
      const propertyInfo = getPropertyInfo(propKey);
      if (suppressHydrationWarning) {
        // Don't bother comparing. We're ignoring all these warnings.
      } else if (
        (enableDeprecatedFlareAPI && propKey === DEPRECATED_flareListeners) ||
        propKey === SUPPRESS_CONTENT_EDITABLE_WARNING ||
        propKey === SUPPRESS_HYDRATION_WARNING ||
        // Controlled attributes are not validated
        // TODO: Only ignore them on controlled tags.
        propKey === 'value' ||
        propKey === 'checked' ||
        propKey === 'selected'
      ) {
        // Noop
      } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
        const serverHTML = domElement.innerHTML;
        const nextHtml = nextProp ? nextProp[HTML] : undefined;
        const expectedHTML = normalizeHTML(
          domElement,
          nextHtml != null ? nextHtml : '',
        );
        if (expectedHTML !== serverHTML) {
          warnForPropDifference(propKey, serverHTML, expectedHTML);
        }
      } else if (propKey === STYLE) {
        // $FlowFixMe - Should be inferred as not undefined.
        extraAttributeNames.delete(propKey);

        if (canDiffStyleForHydrationWarning) {
          const expectedStyle = createDangerousStringForStyles(nextProp);
          serverValue = domElement.getAttribute('style');
          if (expectedStyle !== serverValue) {
            warnForPropDifference(propKey, serverValue, expectedStyle);
          }
        }
      } else if (isCustomComponentTag) {
        // $FlowFixMe - Should be inferred as not undefined.
        extraAttributeNames.delete(propKey.toLowerCase());
        serverValue = getValueForAttribute(domElement, propKey, nextProp);

        if (nextProp !== serverValue) {
          warnForPropDifference(propKey, serverValue, nextProp);
        }
      } else if (
        !shouldIgnoreAttribute(propKey, propertyInfo, isCustomComponentTag) &&
        !shouldRemoveAttribute(
          propKey,
          nextProp,
          propertyInfo,
          isCustomComponentTag,
        )
      ) {
        let isMismatchDueToBadCasing = false;
        if (propertyInfo !== null) {
          // $FlowFixMe - Should be inferred as not undefined.
          extraAttributeNames.delete(propertyInfo.attributeName);
          serverValue = getValueForProperty(
            domElement,
            propKey,
            nextProp,
            propertyInfo,
          );
        } else {
          let ownNamespace = parentNamespace;
          if (ownNamespace === HTML_NAMESPACE) {
            ownNamespace = getIntrinsicNamespace(tag);
          }
          if (ownNamespace === HTML_NAMESPACE) {
            // $FlowFixMe - Should be inferred as not undefined.
            extraAttributeNames.delete(propKey.toLowerCase());
          } else {
            const standardName = getPossibleStandardName(propKey);
            if (standardName !== null && standardName !== propKey) {
              // If an SVG prop is supplied with bad casing, it will
              // be successfully parsed from HTML, but will produce a mismatch
              // (and would be incorrectly rendered on the client).
              // However, we already warn about bad casing elsewhere.
              // So we'll skip the misleading extra mismatch warning in this case.
              isMismatchDueToBadCasing = true;
              // $FlowFixMe - Should be inferred as not undefined.
              extraAttributeNames.delete(standardName);
            }
            // $FlowFixMe - Should be inferred as not undefined.
            extraAttributeNames.delete(propKey);
          }
          serverValue = getValueForAttribute(domElement, propKey, nextProp);
        }

        if (nextProp !== serverValue && !isMismatchDueToBadCasing) {
          warnForPropDifference(propKey, serverValue, nextProp);
        }
      }
    }
  }

  if (__DEV__) {
    // $FlowFixMe - Should be inferred as not undefined.
    if (extraAttributeNames.size > 0 && !suppressHydrationWarning) {
      // $FlowFixMe - Should be inferred as not undefined.
      warnForExtraAttributes(extraAttributeNames);
    }
  }

  switch (tag) {
    case 'input':
      // TODO: Make sure we check if this is still unmounted or do any clean
      // up necessary since we never stop tracking anymore.
      track((domElement: any));
      ReactDOMInputPostMountWrapper(domElement, rawProps, true);
      break;
    case 'textarea':
      // TODO: Make sure we check if this is still unmounted or do any clean
      // up necessary since we never stop tracking anymore.
      track((domElement: any));
      ReactDOMTextareaPostMountWrapper(domElement, rawProps);
      break;
    case 'select':
    case 'option':
      // For input and textarea we current always set the value property at
      // post mount to force it to diverge from attributes. However, for
      // option and select we don't quite do the same thing and select
      // is not resilient to the DOM state changing so we don't do that here.
      // TODO: Consider not doing this for input and textarea.
      break;
    default:
      if (typeof rawProps.onClick === 'function') {
        // TODO: This cast may not be sound for SVG, MathML or custom elements.
        trapClickOnNonInteractiveElement(((domElement: any): HTMLElement));
      }
      break;
  }

  return updatePayload;
}

export function diffHydratedText(textNode: Text, text: string): boolean {
  const isDifferent = textNode.nodeValue !== text;
  return isDifferent;
}

export function warnForUnmatchedText(textNode: Text, text: string) {
  if (__DEV__) {
    warnForTextDifference(textNode.nodeValue, text);
  }
}

export function warnForDeletedHydratableElement(
  parentNode: Element | Document,
  child: Element,
) {
  if (__DEV__) {
    if (didWarnInvalidHydration) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Did not expect server HTML to contain a <%s> in <%s>.',
      child.nodeName.toLowerCase(),
      parentNode.nodeName.toLowerCase(),
    );
  }
}

export function warnForDeletedHydratableText(
  parentNode: Element | Document,
  child: Text,
) {
  if (__DEV__) {
    if (didWarnInvalidHydration) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Did not expect server HTML to contain the text node "%s" in <%s>.',
      child.nodeValue,
      parentNode.nodeName.toLowerCase(),
    );
  }
}

export function warnForInsertedHydratedElement(
  parentNode: Element | Document,
  tag: string,
  props: Object,
) {
  if (__DEV__) {
    if (didWarnInvalidHydration) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Expected server HTML to contain a matching <%s> in <%s>.',
      tag,
      parentNode.nodeName.toLowerCase(),
    );
  }
}

export function warnForInsertedHydratedText(
  parentNode: Element | Document,
  text: string,
) {
  if (__DEV__) {
    if (text === '') {
      // We expect to insert empty text nodes since they're not represented in
      // the HTML.
      // TODO: Remove this special case if we can just avoid inserting empty
      // text nodes.
      return;
    }
    if (didWarnInvalidHydration) {
      return;
    }
    didWarnInvalidHydration = true;
    console.error(
      'Expected server HTML to contain a matching text node for "%s" in <%s>.',
      text,
      parentNode.nodeName.toLowerCase(),
    );
  }
}

export function restoreControlledState(
  domElement: Element,
  tag: string,
  props: Object,
): void {
  switch (tag) {
    case 'input':
      ReactDOMInputRestoreControlledState(domElement, props);
      return;
    case 'textarea':
      ReactDOMTextareaRestoreControlledState(domElement, props);
      return;
    case 'select':
      ReactDOMSelectRestoreControlledState(domElement, props);
      return;
  }
}

export function listenToEventResponderEventTypes(
  eventTypes: Array<string>,
  document: Document,
): void {
  if (enableDeprecatedFlareAPI) {
    // Get the listening Map for this element. We use this to track
    // what events we're listening to.
    const listenerMap = getListenerMapForElement(document);

    // Go through each target event type of the event responder
    for (let i = 0, length = eventTypes.length; i < length; ++i) {
      const eventType = eventTypes[i];
      const isPassive = !endsWith(eventType, '_active');
      const eventKey = isPassive ? eventType + '_passive' : eventType;
      const targetEventType = isPassive
        ? eventType
        : eventType.substring(0, eventType.length - 7);
      if (!listenerMap.has(eventKey)) {
        if (isPassive) {
          const activeKey = targetEventType + '_active';
          // If we have an active event listener, do not register
          // a passive event listener. We use the same active event
          // listener.
          if (listenerMap.has(activeKey)) {
            continue;
          }
        } else {
          // If we have a passive event listener, remove the
          // existing passive event listener before we add the
          // active event listener.
          const passiveKey = targetEventType + '_passive';
          const passiveListener = listenerMap.get(passiveKey);
          if (passiveListener != null) {
            removeActiveResponderEventSystemEvent(
              document,
              targetEventType,
              passiveListener,
            );
          }
        }
        const eventListener = addResponderEventSystemEvent(
          document,
          targetEventType,
          isPassive,
        );
        listenerMap.set(eventKey, eventListener);
      }
    }
  }
}

// We can remove this once the event API is stable and out of a flag
if (enableDeprecatedFlareAPI) {
  setListenToResponderEventTypes(listenToEventResponderEventTypes);
}
