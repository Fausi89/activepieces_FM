import { Edit2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { CalculatedColumn } from 'react-data-grid';

import { Button } from '@/components/ui/button';
import { cn, formatUtils } from '@/lib/utils';
import { FieldType } from '@activepieces/shared';

import { ClientField } from '../lib/store/ap-tables-client-state';
import { Row } from '../lib/types';

import { useTableState } from './ap-table-state-provider';
import { DateEditor } from './date-editor';
import { DropdownEditor } from './dropdown-editor';
import { NumberEditor } from './number-editor';
import { TextEditor } from './text-editor';

type EditableCellProps = {
  field: ClientField;
  value: string;
  row: Row;
  onClick?: () => void;
  column: CalculatedColumn<Row, { id: string }>;
  onRowChange: (row: Row, commitChanges: boolean) => void;
  rowIdx: number;
  disabled?: boolean;
  locked?: boolean;
};

const EditorSelector = ({
  field,
  row,
  rowIdx,
  column,
  value,
  onRowChange,
  setValue,
  setIsEditing,
  setIsHovered,
}: {
  field: ClientField;
  row: Row;
  rowIdx: number;
  column: CalculatedColumn<Row, { id: string }>;
  value: string;
  onRowChange: (row: Row, commitChanges: boolean) => void;
  setValue: (value: string) => void;
  setIsEditing: (isEditing: boolean) => void;
  setIsHovered: (isHovered: boolean) => void;
}) => {
  const handleRowChange = (newRow: Row, commitChanges?: boolean) => {
    if (commitChanges) {
      setValue(newRow[column.key]);
      onRowChange(newRow, commitChanges);
      setIsEditing(false);
    }
  };
  const onClose = () => {
    setIsEditing(false);
    setIsHovered(false);
  };
  const selectedCell = useTableState((state) => state.selectedCell);
  if (
    selectedCell?.rowIdx !== rowIdx ||
    selectedCell?.columnIdx !== column.idx
  ) {
    onClose();
    return null;
  }
  switch (field.type) {
    case FieldType.DATE:
      return (
        <DateEditor
          row={row}
          rowIdx={rowIdx}
          column={column}
          value={value}
          onRowChange={handleRowChange}
          onClose={onClose}
        />
      );
    case FieldType.NUMBER:
      return (
        <NumberEditor
          row={row}
          rowIdx={rowIdx}
          column={column}
          value={value}
          onRowChange={handleRowChange}
          onClose={onClose}
        ></NumberEditor>
      );
    case FieldType.STATIC_DROPDOWN:
      return (
        <DropdownEditor
          row={row}
          rowIdx={rowIdx}
          column={column}
          value={value}
          onRowChange={handleRowChange}
          onClose={onClose}
          field={field}
        ></DropdownEditor>
      );
    default:
      return (
        <TextEditor
          row={row}
          rowIdx={rowIdx}
          column={column}
          value={value}
          onRowChange={handleRowChange}
          onClose={onClose}
        />
      );
  }
};
export function EditableCell({
  field,
  value: initialValue,
  row,
  column,
  onRowChange,
  rowIdx,
  onClick,
  disabled = false,
  locked = false,
}: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [selectedCell, setSelectedCell] = useTableState((state) => [
    state.selectedCell,
    state.setSelectedCell,
  ]);
  const [value, setValue] = useState(initialValue);
  const isSelected =
    selectedCell?.rowIdx === rowIdx && selectedCell?.columnIdx === column.idx;
  const displayedValue = value?.trim()?.replace(/\n/g, ' ');
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      id={`editable-cell-${rowIdx}-${column.idx}`}
      className={
        isEditing
          ? 'h-full'
          : cn(
              'h-full flex items-center justify-between gap-2 pl-2 py-2  focus:outline-none  ',
              'group cursor-pointer border',
              isSelected && !locked ? 'border-primary' : 'border-transparent',
              locked && 'locked-row',
            )
      }
      onMouseEnter={() => {
        if (!disabled) {
          setIsHovered(true);
        }
      }}
      tabIndex={0}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => {
        onClick?.();
        setSelectedCell({ rowIdx, columnIdx: column.idx });
        if (!disabled && field.type === FieldType.STATIC_DROPDOWN) {
          setIsEditing(true);
        }
      }}
      onFocus={() => {
        setSelectedCell({ rowIdx, columnIdx: column.idx });
      }}
      onDoubleClick={() => {
        if (!disabled) {
          setIsEditing(true);
        }
      }}
      onKeyDown={(e) => {
        const isTypingKey = e.key.length === 1;
        if (isTypingKey && !disabled && !isEditing) {
          setIsEditing(true);
          setSelectedCell({ rowIdx, columnIdx: column.idx });
        }
      }}
    >
      {isEditing && (
        <EditorSelector
          field={field}
          row={row}
          rowIdx={rowIdx}
          column={column}
          value={value}
          onRowChange={(newRow, commitChanges) => {
            if (isEditing) {
              onRowChange(newRow, commitChanges);
            }
          }}
          setValue={setValue}
          setIsEditing={(newIsEditing) => {
            setIsEditing(newIsEditing);
            if (!newIsEditing) {
              requestAnimationFrame(() => {
                // need to refocus container so keyboard navigation between cells works
                // if it was done immediately, the cell would be blurred and call handleRowChange
                containerRef.current?.focus();
              });
            }
          }}
          setIsHovered={setIsHovered}
        />
      )}
      {!isEditing && (
        <span className="flex-1 truncate">
          {field.type === FieldType.DATE && displayedValue
            ? formatUtils.formatDateOnly(new Date(displayedValue))
            : displayedValue}
        </span>
      )}
      {isHovered && !isEditing && (
        <Button
          variant="transparent"
          size="sm"
          className="text-gray-500"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditing(true);
          }}
        >
          <div className="hover:bg-primary/10 p-1">
            <Edit2 className="h-4 w-4 text-muted-foreground" />
          </div>
        </Button>
      )}
    </div>
  );
}
