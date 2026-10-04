import { useState } from 'react';
import { Alert, Checkbox, Input, Modal, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { ResultRow } from '../shared/contracts';
import { api } from './api';
export function ResultEditor({
  item,
  onClose,
  onSaved,
}: {
  item: ResultRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(item.target_text || '');
  const [approved, setApproved] = useState(item.approved);
  const save = useMutation({
    mutationFn: () =>
      api.edit(item.job_id, item.id, {
        text,
        approved,
        revision: item.revision,
      }),
    onSuccess: onSaved,
  });
  return (
    <Modal
      open
      title={`编辑 · ${item.source_key} / ${item.language}`}
      onCancel={onClose}
      onOk={() => save.mutate()}
      confirmLoading={save.isPending}
      okText="保存结果"
      cancelText="取消"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">英文原文</Typography.Paragraph>
      <Typography.Paragraph>{item.source_text}</Typography.Paragraph>
      <label htmlFor="edit-translation">翻译内容</label>
      <Input.TextArea
        id="edit-translation"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
      />
      <Checkbox
        checked={approved}
        onChange={(e) => setApproved(e.target.checked)}
        style={{ marginTop: 16 }}
      >
        我已检查内容，标记为已审核
      </Checkbox>
      {save.error ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message={save.error.message}
        />
      ) : null}
    </Modal>
  );
}
