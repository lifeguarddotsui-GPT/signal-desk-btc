import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderOpen, FileCode, ChevronRight, ChevronDown, Search, Copy, Check, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
};

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), isFile: false };
  for (const file of files) {
    const parts = file.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          children: new Map(),
          isFile: i === parts.length - 1,
        });
      }
      current = current.children.get(part)!;
    }
  }
  return root;
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.substring(dot) : "";
}

function getLanguage(filename: string): string {
  const ext = getExtension(filename);
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".json": "json", ".css": "css", ".html": "html", ".toml": "toml",
    ".move": "move", ".md": "markdown",
  };
  return map[ext] || "text";
}

function getExtColor(filename: string): string {
  const ext = getExtension(filename);
  const map: Record<string, string> = {
    ".ts": "text-blue-400", ".tsx": "text-blue-300", ".js": "text-yellow-400",
    ".jsx": "text-yellow-300", ".json": "text-green-400", ".css": "text-purple-400",
    ".html": "text-orange-400", ".move": "text-cyan-400", ".md": "text-muted-foreground",
    ".toml": "text-amber-400",
  };
  return map[ext] || "text-muted-foreground";
}

function FileTreeItem({
  node,
  depth,
  selectedFile,
  onSelect,
  expandedDirs,
  toggleDir,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
}) {
  const sorted = Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((child) => {
        const isExpanded = expandedDirs.has(child.path);
        const isSelected = selectedFile === child.path;

        if (child.isFile) {
          return (
            <button
              key={child.path}
              onClick={() => onSelect(child.path)}
              className={`flex items-center gap-1.5 w-full text-left py-1 px-2 rounded-md text-xs font-mono truncate transition-colors ${
                isSelected
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover-elevate"
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              data-testid={`file-tree-item-${child.path.replace(/[\/\.]/g, "-")}`}
            >
              <FileCode className={`h-3.5 w-3.5 shrink-0 ${getExtColor(child.name)}`} />
              <span className="truncate">{child.name}</span>
            </button>
          );
        }

        return (
          <div key={child.path}>
            <button
              onClick={() => toggleDir(child.path)}
              className="flex items-center gap-1.5 w-full text-left py-1 px-2 rounded-md text-xs font-medium truncate text-foreground/80 hover-elevate"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              data-testid={`folder-tree-item-${child.path.replace(/[\/\.]/g, "-")}`}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="truncate">{child.name}</span>
            </button>
            {isExpanded && (
              <FileTreeItem
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelect={onSelect}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function OpenCode() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    new Set(["client", "client/src", "server", "shared", "move"])
  );
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const { data: files, isLoading: treeLoading } = useQuery<string[]>({
    queryKey: ["/api/code/tree"],
  });

  const { data: fileData, isLoading: fileLoading, error: fileError } = useQuery<{ path: string; content: string }>({
    queryKey: ["/api/code/file", selectedFile],
    queryFn: async () => {
      const res = await fetch(`/api/code/file?path=${encodeURIComponent(selectedFile!)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load file" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    enabled: !!selectedFile,
  });

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const filteredFiles = files?.filter((f) =>
    searchQuery ? f.toLowerCase().includes(searchQuery.toLowerCase()) : true
  );

  const tree = filteredFiles ? buildTree(filteredFiles) : null;

  const handleCopy = async () => {
    if (fileData?.content) {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      toast({ title: "Copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const lineCount = fileData?.content?.split("\n").length || 0;

  return (
    <div className="flex flex-col h-[calc(100vh-2.25rem)]">
      <div className="flex items-center gap-2 px-4 py-2 border-b flex-wrap">
        <FolderOpen className="h-5 w-5 text-primary shrink-0" />
        <h1 className="text-base font-semibold" data-testid="text-open-code-title">Open Code</h1>
        <Badge variant="secondary" className="text-[10px]" data-testid="badge-file-count">
          {files?.length || 0} files
        </Badge>
        {selectedFile && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedFile(null)}
            className="ml-auto md:hidden"
            data-testid="button-back-to-tree"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div
          className={`w-full md:w-64 lg:w-72 border-r flex flex-col shrink-0 ${
            selectedFile ? "hidden md:flex" : "flex"
          }`}
        >
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-7 text-xs"
                data-testid="input-search-files"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="py-1">
              {treeLoading ? (
                <div className="space-y-1 p-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : tree ? (
                <FileTreeItem
                  node={tree}
                  depth={0}
                  selectedFile={selectedFile}
                  onSelect={setSelectedFile}
                  expandedDirs={expandedDirs}
                  toggleDir={toggleDir}
                />
              ) : (
                <p className="text-xs text-muted-foreground p-4">No files found</p>
              )}
            </div>
          </ScrollArea>
        </div>

        <div
          className={`flex-1 flex flex-col min-w-0 ${
            !selectedFile ? "hidden md:flex" : "flex"
          }`}
        >
          {selectedFile ? (
            <>
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b bg-muted/30 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className={`h-4 w-4 shrink-0 ${getExtColor(selectedFile)}`} />
                  <span className="text-xs font-mono truncate" data-testid="text-current-file">
                    {selectedFile}
                  </span>
                  <Badge variant="outline" className="text-[9px] shrink-0">
                    {getLanguage(selectedFile)}
                  </Badge>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {lineCount > 0 && (
                    <span className="text-[10px] text-muted-foreground" data-testid="text-line-count">
                      {lineCount} lines
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleCopy}
                    disabled={!fileData?.content}
                    data-testid="button-copy-code"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1">
                {fileLoading ? (
                  <div className="space-y-1 p-4">
                    {Array.from({ length: 20 }).map((_, i) => (
                      <Skeleton key={i} className="h-4 w-full" />
                    ))}
                  </div>
                ) : fileError ? (
                  <div className="p-6 text-center">
                    <p className="text-sm text-destructive" data-testid="text-file-error">
                      {(fileError as Error).message}
                    </p>
                  </div>
                ) : fileData?.content ? (
                  <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto" data-testid="code-content">
                    {fileData.content.split("\n").map((line, i) => (
                      <div key={i} className="flex">
                        <span className="inline-block w-10 shrink-0 text-right pr-3 text-muted-foreground/50 select-none">
                          {i + 1}
                        </span>
                        <span className="flex-1">{line || " "}</span>
                      </div>
                    ))}
                  </pre>
                ) : null}
              </ScrollArea>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <FileCode className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground" data-testid="text-select-prompt">
                  Select a file to view its source code
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
