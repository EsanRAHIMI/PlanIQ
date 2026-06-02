"""Train YOLOv11 on plan symbols. Produces models/plan-symbols.pt.
Usage: python training/train.py --epochs 100 --imgsz 1280
"""
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--base", default="yolo11s.pt")
    ap.add_argument("--out", default="../models/plan-symbols.pt")
    args = ap.parse_args()

    from ultralytics import YOLO
    model = YOLO(args.base)
    results = model.train(data="data.yaml", epochs=args.epochs, imgsz=args.imgsz, batch=8,
                          patience=20, project="runs", name="plan-symbols")
    # export best weights
    best = results.save_dir / "weights" / "best.pt"
    import shutil, os
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    shutil.copy(best, args.out)
    print(f"Saved weights -> {args.out}")


if __name__ == "__main__":
    main()
