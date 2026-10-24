import React from "react";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";

/** Asks before something that changes data. danger makes the confirm button red. */
export function ConfirmDialog({
  show,
  title,
  children,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  disabled = false,
  onConfirm,
  onCancel,
  ...rest
}) {
  return (
    <Modal show={show} onHide={onCancel} {...rest}>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="fs-5">
          {title}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>{children}</Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={busy || disabled}
          data-testid="confirm"
        >
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
