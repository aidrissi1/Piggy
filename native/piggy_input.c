/**
 * Piggy — Native Input Driver (macOS)
 * Hardware-level mouse and keyboard events via CoreGraphics.
 *
 * Uses CGEventCreateMouseEvent + kCGHIDEventTap so events are
 * indistinguishable from real hardware input. No synthetic flags.
 *
 * Built as a Node N-API addon.
 *
 * @author Idrissi
 * @license MIT
 */

#include <node_api.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>

// ── Mouse ─────────────────────────────────────────────────

static napi_value MoveMouse(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  double x, y;
  napi_get_value_double(env, args[0], &x);
  napi_get_value_double(env, args[1], &y);

  // Bounds check
  if (x < 0) x = 0;
  if (y < 0) y = 0;

  CGPoint point = CGPointMake(x, y);
  CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value ClickMouse(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  double x, y;
  int32_t button = 0; // 0 = left, 1 = right
  napi_get_value_double(env, args[0], &x);
  napi_get_value_double(env, args[1], &y);
  if (argc > 2) napi_get_value_int32(env, args[2], &button);

  CGPoint point = CGPointMake(x, y);
  CGMouseButton btn = (button == 1) ? kCGMouseButtonRight : kCGMouseButtonLeft;
  CGEventType downType = (button == 1) ? kCGEventRightMouseDown : kCGEventLeftMouseDown;
  CGEventType upType = (button == 1) ? kCGEventRightMouseUp : kCGEventLeftMouseUp;

  CGEventRef down = CGEventCreateMouseEvent(NULL, downType, point, btn);
  CGEventRef up = CGEventCreateMouseEvent(NULL, upType, point, btn);

  CGEventPost(kCGHIDEventTap, down);
  usleep(20000); // 20ms between down and up (human-like)
  CGEventPost(kCGHIDEventTap, up);

  CFRelease(down);
  CFRelease(up);

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value ScrollMouse(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t amount;
  napi_get_value_int32(env, args[0], &amount);

  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, amount);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value GetMousePos(napi_env env, napi_callback_info info) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);

  napi_value obj, xVal, yVal;
  napi_create_object(env, &obj);
  napi_create_double(env, point.x, &xVal);
  napi_create_double(env, point.y, &yVal);
  napi_set_named_property(env, obj, "x", xVal);
  napi_set_named_property(env, obj, "y", yVal);
  return obj;
}

// ── Keyboard ──────────────────────────────────────────────

static napi_value TypeChar(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  // Get the UTF-16 character
  size_t len;
  napi_get_value_string_utf16(env, args[0], NULL, 0, &len);
  char16_t buf[8] = {0};
  napi_get_value_string_utf16(env, args[0], buf, 8, &len);

  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);

  // Set the Unicode string — this handles ALL characters regardless of keyboard layout
  UniChar uniChar = (UniChar)buf[0];
  CGEventKeyboardSetUnicodeString(down, 1, &uniChar);
  CGEventKeyboardSetUnicodeString(up, 1, &uniChar);

  CGEventPost(kCGHIDEventTap, down);
  CGEventPost(kCGHIDEventTap, up);

  CFRelease(down);
  CFRelease(up);

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

// Map key names to CGKeyCode
static CGKeyCode keyNameToCode(const char* name) {
  if (strcmp(name, "enter") == 0 || strcmp(name, "return") == 0) return kVK_Return;
  if (strcmp(name, "tab") == 0) return kVK_Tab;
  if (strcmp(name, "escape") == 0) return kVK_Escape;
  if (strcmp(name, "backspace") == 0) return kVK_Delete;
  if (strcmp(name, "delete") == 0) return kVK_ForwardDelete;
  if (strcmp(name, "space") == 0) return kVK_Space;
  if (strcmp(name, "up") == 0) return kVK_UpArrow;
  if (strcmp(name, "down") == 0) return kVK_DownArrow;
  if (strcmp(name, "left") == 0) return kVK_LeftArrow;
  if (strcmp(name, "right") == 0) return kVK_RightArrow;
  if (strcmp(name, "command") == 0) return kVK_Command;
  if (strcmp(name, "shift") == 0) return kVK_Shift;
  if (strcmp(name, "control") == 0) return kVK_Control;
  if (strcmp(name, "alt") == 0 || strcmp(name, "option") == 0) return kVK_Option;
  if (strcmp(name, "home") == 0) return kVK_Home;
  if (strcmp(name, "end") == 0) return kVK_End;
  if (strcmp(name, "pageup") == 0) return kVK_PageUp;
  if (strcmp(name, "pagedown") == 0) return kVK_PageDown;
  if (strcmp(name, "f1") == 0) return kVK_F1;
  if (strcmp(name, "f2") == 0) return kVK_F2;
  if (strcmp(name, "f3") == 0) return kVK_F3;
  if (strcmp(name, "f4") == 0) return kVK_F4;
  if (strcmp(name, "f5") == 0) return kVK_F5;
  if (strcmp(name, "f6") == 0) return kVK_F6;
  if (strcmp(name, "f7") == 0) return kVK_F7;
  if (strcmp(name, "f8") == 0) return kVK_F8;
  if (strcmp(name, "f9") == 0) return kVK_F9;
  if (strcmp(name, "f10") == 0) return kVK_F10;
  if (strcmp(name, "f11") == 0) return kVK_F11;
  if (strcmp(name, "f12") == 0) return kVK_F12;
  // Single letter keys
  if (strlen(name) == 1) {
    char c = name[0];
    if (c == 'a') return kVK_ANSI_A;
    if (c == 'b') return kVK_ANSI_B;
    if (c == 'c') return kVK_ANSI_C;
    if (c == 'd') return kVK_ANSI_D;
    if (c == 'e') return kVK_ANSI_E;
    if (c == 'f') return kVK_ANSI_F;
    if (c == 'g') return kVK_ANSI_G;
    if (c == 'h') return kVK_ANSI_H;
    if (c == 'i') return kVK_ANSI_I;
    if (c == 'j') return kVK_ANSI_J;
    if (c == 'k') return kVK_ANSI_K;
    if (c == 'l') return kVK_ANSI_L;
    if (c == 'm') return kVK_ANSI_M;
    if (c == 'n') return kVK_ANSI_N;
    if (c == 'o') return kVK_ANSI_O;
    if (c == 'p') return kVK_ANSI_P;
    if (c == 'q') return kVK_ANSI_Q;
    if (c == 'r') return kVK_ANSI_R;
    if (c == 's') return kVK_ANSI_S;
    if (c == 't') return kVK_ANSI_T;
    if (c == 'u') return kVK_ANSI_U;
    if (c == 'v') return kVK_ANSI_V;
    if (c == 'w') return kVK_ANSI_W;
    if (c == 'x') return kVK_ANSI_X;
    if (c == 'y') return kVK_ANSI_Y;
    if (c == 'z') return kVK_ANSI_Z;
  }
  return 0;
}

static napi_value KeyTap(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  char keyName[32];
  size_t len;
  napi_get_value_string_utf8(env, args[0], keyName, 32, &len);

  // Get modifier flags from second arg (array of strings)
  CGEventFlags flags = 0;
  if (argc > 1) {
    uint32_t modCount;
    napi_get_array_length(env, args[1], &modCount);
    for (uint32_t i = 0; i < modCount; i++) {
      napi_value modVal;
      napi_get_element(env, args[1], i, &modVal);
      char mod[32];
      napi_get_value_string_utf8(env, modVal, mod, 32, &len);
      if (strcmp(mod, "command") == 0) flags |= kCGEventFlagMaskCommand;
      if (strcmp(mod, "shift") == 0) flags |= kCGEventFlagMaskShift;
      if (strcmp(mod, "control") == 0) flags |= kCGEventFlagMaskControl;
      if (strcmp(mod, "alt") == 0 || strcmp(mod, "option") == 0) flags |= kCGEventFlagMaskAlternate;
    }
  }

  CGKeyCode code = keyNameToCode(keyName);

  CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);

  if (flags) {
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
  }

  CGEventPost(kCGHIDEventTap, down);
  CGEventPost(kCGHIDEventTap, up);

  CFRelease(down);
  CFRelease(up);

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

// ── Module Init ───────────────────────────────────────────

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "moveMouse",   NULL, MoveMouse,   NULL, NULL, NULL, napi_default, NULL },
    { "clickMouse",  NULL, ClickMouse,  NULL, NULL, NULL, napi_default, NULL },
    { "scrollMouse", NULL, ScrollMouse, NULL, NULL, NULL, napi_default, NULL },
    { "getMousePos", NULL, GetMousePos, NULL, NULL, NULL, napi_default, NULL },
    { "typeChar",    NULL, TypeChar,    NULL, NULL, NULL, napi_default, NULL },
    { "keyTap",      NULL, KeyTap,      NULL, NULL, NULL, napi_default, NULL },
  };

  napi_define_properties(env, exports, 6, props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
