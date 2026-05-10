package paths

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

var ErrInvalid = errors.New("path.invalid")

func SafeRelative(p string) (string, error) {
	if p == "" || filepath.IsAbs(p) || strings.Contains(p, "\\") {
		return "", ErrInvalid
	}
	clean := filepath.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return "", ErrInvalid
	}
	return clean, nil
}

func ResolveInside(root, rel string) (string, error) {
	safe, err := SafeRelative(rel)
	if err != nil {
		return "", err
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", ErrInvalid
	}
	target := filepath.Join(rootReal, safe)
	if _, err := os.Lstat(target); err != nil {
		return "", err
	}
	targetReal, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", ErrInvalid
	}
	if !Contains(rootReal, targetReal) {
		return "", ErrInvalid
	}
	return targetReal, nil
}

func Contains(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	if root == target {
		return true
	}
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

func InAllowedRoots(path string, roots []string) bool {
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		abs, absErr := filepath.Abs(path)
		if absErr != nil {
			return false
		}
		realPath = abs
	}
	for _, root := range roots {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			realRoot = root
		}
		if Contains(realRoot, realPath) {
			return true
		}
	}
	return false
}
